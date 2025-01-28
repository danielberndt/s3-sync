import {createHash} from "node:crypto";
import {createReadStream, promises as fs} from "node:fs";
import {join, relative} from "node:path";
import Bottleneck from "bottleneck";
import mime from "mime-types";
import {
  S3Client,
  ListObjectsV2Command,
  PutObjectCommand,
  DeleteObjectCommand,
  S3ClientConfig,
  PutObjectCommandInput,
} from "@aws-sdk/client-s3";
import {
  CloudFrontClient,
  CloudFrontClientConfig,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";

const calculateMD5 = (filePath: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("data", (data) => hash.update(data));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });

async function* getFiles(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, {withFileTypes: true, recursive: true});
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    yield join(entry.path, entry.name);
  }
}

type LocalFileInfo = {key: string; md5: string; localPath: string};

const getLocalFiles = async (config: SyncConfig) => {
  const map = new Map<string, LocalFileInfo>();
  for await (const file of getFiles(config.path)) {
    const key = relative(config.path, file);
    map.set(key, {key, md5: await calculateMD5(file), localPath: file});
  }
  return map;
};

type RemoteFileInfo = {
  key: string;
  md5: string | null;
  lastModified: Date | null;
};

const safeParseJson = <T>(str: string): T | null => {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
};

const getRemoteFiles = async (client: S3Client, config: SyncConfig) => {
  const map = new Map<string, RemoteFileInfo>();

  let isTruncated = true;

  const command = new ListObjectsV2Command({
    Bucket: config.bucket,
  });

  while (isTruncated) {
    const res = await client.send(command);
    const {Contents, IsTruncated, NextContinuationToken} = res;
    for (const obj of Contents || []) {
      const key = obj.Key!;
      map.set(key, {
        key,
        md5: obj.ETag ? safeParseJson(obj.ETag) : null,
        lastModified: obj.LastModified ?? null,
      });
    }
    isTruncated = IsTruncated!;
    command.input.ContinuationToken = NextContinuationToken;
  }
  return map;
};

const upload = async (opts: {
  client: S3Client;
  config: SyncConfig;
  localFiles: Map<string, LocalFileInfo>;
  remoteFiles: Map<string, RemoteFileInfo>;
}) => {
  const {client, config, localFiles, remoteFiles} = opts;

  const uploadLimiter = new Bottleneck({
    maxConcurrent: config.parallelUploads ?? 10,
  });

  const addPut = (key: string, command: PutObjectCommand) =>
    uploadLimiter.schedule(async () => {
      const startFile = performance.now();
      console.log("🔄", key);
      await client.send(command);
      console.log(
        "✅",
        key,
        `in ${Math.round(performance.now() - startFile)}ms`
      );
    });

  let needsInvalidation = false;

  for (const [key, local] of localFiles) {
    const remote = remoteFiles.get(key);
    remoteFiles.delete(key);
    if (remote) {
      if (remote.md5 === local.md5) {
        // console.log("md5 matches", key);
        continue;
      } else {
        needsInvalidation = true;
      }
    }
    const getCacheControl = () => {
      if (key.endsWith(".html") || key.endsWith(".txt")) {
        return "no-cache, must-revalidate, s-maxage=315360000";
      }
      if (key === "favicon.ico") {
        return "public, max-age=43200, s-maxage=315360000";
      }
      return "public, max-age=31536000, immutable";
    };
    const command = new PutObjectCommand({
      Bucket: config.bucket,
      Key: local.key,
      Body: createReadStream(local.localPath),
      ACL: "public-read",
      CacheControl: getCacheControl(),
      ContentType: mime.lookup(local.localPath) || "application/octet-stream",
      ...config.putObjectConfig?.(local.localPath),
    });
    void addPut(local.key, command);
  }
  const {customPuts} = config;
  if (customPuts) {
    for (const {command, md5} of customPuts) {
      const key = command.input.Key!;
      const remote = remoteFiles.get(key);
      remoteFiles.delete(key);
      if (remote) {
        if (md5 && remote.md5 === md5) {
          continue;
        } else {
          needsInvalidation = true;
        }
      }
      void addPut(key, command);
    }
  }

  await uploadLimiter.stop({dropWaitingJobs: false});
  return {needsInvalidation};
};

const performInvalidation = async (config: SyncConfig) => {
  const cfClient = new CloudFrontClient({
    region: config.region,
    ...config.cloudfrontClientConfig,
  });
  console.log("🔄", "invalidating");
  const invalidation = new CreateInvalidationCommand({
    DistributionId: config.cloudfrontDistributionId,
    InvalidationBatch: {
      CallerReference: new Date().toISOString(),
      Paths: {
        Quantity: 1,
        Items: ["/*"],
      },
    },
  });
  await cfClient.send(invalidation);
  console.log("✅", "invalidation done");
};

const deleteOldFiles = async (opts: {
  config: SyncConfig;
  remoteFiles: Map<string, RemoteFileInfo>;
  client: S3Client;
}) => {
  const {config, remoteFiles, client} = opts;

  if (remoteFiles.size > 0) {
    const deleteLimiter = new Bottleneck({
      maxConcurrent: config.parallelUploads ?? 10,
    });
    for (const [key, info] of remoteFiles) {
      const tooOld = () => {
        if (!info.lastModified) return true;
        const ageInDays =
          (Date.now() - info.lastModified.getTime()) / 1000 / 60 / 60 / 24;
        return ageInDays > config.deleteAfterMaxAgeInDays;
      };
      if (tooOld()) {
        void deleteLimiter.schedule(async () => {
          await client.send(
            new DeleteObjectCommand({
              Bucket: process.env.S3_BUCKET,
              Key: key,
            })
          );
          console.log("❌", key);
        });
      }
    }
    await deleteLimiter.stop({dropWaitingJobs: false});
  }
};

type SyncConfig = {
  path: string;
  bucket: string;
  deleteAfterMaxAgeInDays: number;
  region: string;
  s3ClientConfig?: S3ClientConfig;
  putObjectConfig?: (path: string) => PutObjectCommandInput;
  cloudfrontClientConfig?: CloudFrontClientConfig;
  cloudfrontDistributionId: string;
  parallelUploads?: number;
  customPuts?: {command: PutObjectCommand; md5?: string}[];
};

const sync = async (config: SyncConfig) => {
  const start = performance.now();
  const s3 = new S3Client({region: config.region, ...config.s3ClientConfig});
  const [localFiles, remoteFiles] = await Promise.all([
    getLocalFiles(config),
    getRemoteFiles(s3, config),
  ]);
  console.log(`🔁 synced in ${Math.round(performance.now() - start)}ms`);
  const {needsInvalidation} = await upload({
    client: s3,
    config,
    localFiles,
    remoteFiles,
  });

  await Promise.all([
    ...(needsInvalidation ? [performInvalidation(config)] : []),
    deleteOldFiles({config, remoteFiles, client: s3}),
  ]);
};

export default sync;
