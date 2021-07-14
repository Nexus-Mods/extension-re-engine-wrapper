import Promise from 'bluebird';
import path from 'path';
import { fs, selectors, types, util } from 'vortex-api';
import { CACHE_FILE, INVAL_FILE } from './common';

import { ICache, ICacheEntry, IListEntry, InvalidationCacheError } from './types';

export class InvalidationCache {
  public static getInstance(api: types.IExtensionApi): InvalidationCache {
    const currentGameMode = selectors.activeGameId(api.getState());
    if (!this.instance) {
      this.instance = new this(api, currentGameMode);
    } else {
      this.instance.mGameMode = currentGameMode;
    }

    return this.instance;
  }

  private static instance: InvalidationCache;

  private mAPI: types.IExtensionApi;
  private mGameMode: string;
  private mQueue: (cb: () => Promise<any>, tryOnly: boolean) => Promise<any>;

  private constructor(api: types.IExtensionApi, gameId: string) {
    this.mAPI = api;
    this.mGameMode = gameId;
    this.mQueue = util.makeQueue<any>();
  }

  public migrateInvalCache(): Promise<void> {
    let cacheLocation;
    try {
      const stagingFolder = this.getStagingFolder();
      cacheLocation = path.join(stagingFolder, CACHE_FILE);
    } catch (err) {
      return Promise.reject(err);
    }

    return this.mQueue(() => fs.removeAsync(cacheLocation), false)
      .catch(err => ['ENOENT', 'ENOTFOUND'].includes(err.code)
        ? Promise.resolve()
        : Promise.reject(err))
      .then(() => this.createInvalCache(cacheLocation));
  }

  public createInvalCache(cacheFilePath): Promise<void> {
    return this.mQueue(() => util.writeFileAtomic(cacheFilePath, JSON.stringify({})), false);
  }

  public writeInvalCache(invalCache: ICache): Promise<void> {
    let cacheFilePath;
    try {
      const stagingFolder = this.getStagingFolder();
      cacheFilePath = path.join(stagingFolder, CACHE_FILE);
    } catch (err) {
      return Promise.reject(err);
    }

    return this.mQueue(() =>
      util.writeFileAtomic(cacheFilePath, JSON.stringify(invalCache)), false);
  }

  public readInvalCache(): Promise<ICache> {
    let cacheFilePath;
    try {
      const stagingFolder = this.getStagingFolder();
      cacheFilePath = path.join(stagingFolder, CACHE_FILE);
    } catch (err) {
      return Promise.reject(err);
    }
    return this.mQueue(() => fs.readFileAsync(cacheFilePath, { encoding: 'utf8' }), false)
      .catch(err => (err.code === 'ENOENT')
        ? this.createInvalCache(cacheFilePath).then(() => JSON.stringify({}))
        : Promise.reject(err))
      .then(data => {
        try {
          const invalCache: ICache = JSON.parse(data);
          return Promise.resolve(invalCache);
        } catch (err) {
          return Promise.reject(err);
        }
      });
  }

  public insertOffsets(entries: IListEntry[], arcKey: string): Promise<void> {
    let newCache: ICache = {};
    return this.readInvalCache().then(invalCache => {
      newCache = { ...invalCache };
      if (newCache[arcKey] === undefined) {
        // If we're inserting offsets, we managed to invalidate
        //  filepaths, but the cache template may be missing
        //  new DLC/archive ids - we're going to initiate those
        //  as an empty array at this point.
        newCache[arcKey] = [];
      }
      // tslint:disable-next-line: max-line-length
      const hashEntries: ICacheEntry[] = Object.keys(newCache[arcKey]).map(key => newCache[arcKey][key]);
      return Promise.each(entries, entry => {
        if (hashEntries.find(hash => hash.hashVal === entry.hash) === undefined) {
          const { hash, offset, lowercase, uppercase } = entry;
          const newEntry = {
            hashVal: hash,
            data: { offset, lowercase, uppercase } };
          newCache[arcKey].push(newEntry);
        }
        return Promise.resolve();
      });
    }).then(() => this.writeInvalCache(newCache));
  }

  public removeOffsets(hashes, arcKey: string): Promise<void> {
    let newCache: ICache = {};
    return this.readInvalCache().then(invalCache => {
      newCache = { ...invalCache };
      newCache[arcKey] = Object.keys(invalCache[arcKey])
        .reduce((prev, key) => {
          const entry = newCache[arcKey][key];
          if (hashes.find(hash => hash === entry.hashVal) === undefined) {
            prev.push({ hashVal: entry.hashVal, data: entry.data });
          }
          return prev;
        }, []);
      return this.writeInvalCache(newCache);
    });
  }

  public findArcKeys(hashes): Promise<{ [arcKey: string]: number[] }> {
    return this.readInvalCache().then(invalCache => {
      const keys = Object.keys(invalCache);
      const arcKeys = hashes.reduce((prev, hash) => {
        keys.forEach(key => {
          if (prev[key] === undefined) {
            prev[key] = [];
          }
          const entries = Object.keys(invalCache[key]).map(id => invalCache[key][id]);
          if (entries.find(entry => entry.hashVal === hash) !== undefined) {
            prev[key].push(+hash);
          }
        });
        return prev;
      }, {});
      return Promise.resolve(arcKeys);
    });
  }

  public readNewInvalEntries(invalFilePath: string): Promise<IListEntry[]> {
    let iter = 0;
    const entries = [];
    return fs.readFileAsync(invalFilePath)
      .then(data => {
        const totalFiles = this.byteArrayTo32Int(data.slice(data.byteLength - 4));
        for (let i = 0; i < totalFiles; i++) {
          const offset = data.slice(iter, iter + 8);
          const lowercase = data.slice(iter + 8, iter + 12);
          const hash = this.byteArrayTo32Int(lowercase);
          const uppercase = data.slice(iter + 12, iter + 16);
          iter += 16;
          entries.push({ hash, offset, lowercase, uppercase });
        }
        return Promise.resolve(entries);
      });
  }

  public hasHash(hash): Promise<boolean> {
    return this.readInvalCache().then(invalCache => {
      const keys = Object.keys(invalCache);
      keys.forEach(key => {
        const hashEntry = Object.keys(invalCache[key])
          .find(entry => invalCache[key][entry].hashVal === hash);
        if (hashEntry !== undefined) {
          return Promise.resolve(true);
        }
      });
      return Promise.resolve(false);
    });
  }

  public getInvalEntries(hashes, arcKey): Promise<any[]> {
    return this.readInvalCache().then(invalCache => {
      const entries = Object.keys(invalCache[arcKey]).reduce((prev, key) => {
        const entry = invalCache[arcKey][key];
        if (hashes.find(hash => entry.hashVal === hash) !== undefined) {
          const offsetBuf = Buffer.from(entry.data['offset'].data);
          const lowerCaseBuf = Buffer.from(entry.data['lowercase'].data);
          const upperCaseBuf = Buffer.from(entry.data['uppercase'].data);
          prev.push({
            offset: offsetBuf,
            lowercase: lowerCaseBuf,
            uppercase: upperCaseBuf,
          });
        }
        return prev;
      }, []);

      return Promise.resolve(entries || []);
    });
  }
  public writeInvalEntries(writeDir: string, entries) {
    const invalFilePath = path.join(writeDir, INVAL_FILE);
    let invalFileBuffer = Buffer.alloc(0);
    const totalFilesBuffer = Buffer.alloc(4);
    totalFilesBuffer.writeInt32LE(entries.length, 0);
    let iter = 0;
    for (const entry of entries) {
      iter += 16;
      invalFileBuffer = Buffer.concat([
        invalFileBuffer,
        entry.offset,
        entry.lowercase,
        entry.uppercase], iter);
    }
    invalFileBuffer = Buffer.concat([ invalFileBuffer, totalFilesBuffer ], iter + 4);
    return util.writeFileAtomic(invalFilePath, invalFileBuffer);
  }

  private getStagingFolder() {
    const stagingFolder = selectors.installPathForGame(this.mAPI.getState(), this.mGameMode);
    if (stagingFolder === undefined) {
      // How ?
      throw new InvalidationCacheError('Game is no longer being managed by Vortex');
    }

    return stagingFolder;
  }

  private byteArrayTo32Int(byteArray) {
    if (byteArray.length > 4) {
      return -1;
    }
    let value = 0;
    for (let i = byteArray.length - 1; i >= 0; i--) {
      value = (value * 256) + byteArray[i];
    }
    return value;
  }
}

export default InvalidationCache;
