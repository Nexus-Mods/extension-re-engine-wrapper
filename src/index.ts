import * as Bluebird from 'bluebird';
import { app, remote } from 'electron';
import path from 'path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import turbowalk, { IEntry } from 'turbowalk';

import cache, { InvalidationCache } from './cache';
import { CACHE_FILE } from './common';
import murmur3 from './murmur3';
import {
  IArchiveMatch, IAttachmentData, IProps, IREEngineConfig, IREEngineGameSupport,
  REGameRegistrationError, ValidationError,
} from './types';

import { genProps, getStagingFilePath } from './util';

const uniApp = app || remote.app;

const QBMS_TEMP_PATH = path.join(uniApp.getPath('userData'), 'temp', 'qbms');
const RE_ENGINE_GAMES: IREEngineGameSupport = {};
export const getSupportMap = () => RE_ENGINE_GAMES;

const ACTIVITY_INVAL = 're_engine_invalidation';
const ACTIVITY_REVAL = 're_engine_revalidation';

// RE Engine games require us to invalidate/zero-out file entries within
//  the game's pak file; the filtered.list file is generated
//  using the full file list.
const FILTERED_LIST = path.join(QBMS_TEMP_PATH, 'filtered.list');

async function ensureListBackup(state: types.IState, gameId: string): Promise<string> {
  const gameConf: IREEngineConfig = RE_ENGINE_GAMES[gameId];
  if (gameConf === undefined) {
    return Promise.reject(new Error('[RE-Wrapper] failed to create file list backup'));
  }

  const stagingFolder: string = selectors.installPathForGame(state, gameId);
  const backupPath: string = path.join(stagingFolder, path.basename(gameConf.fileListPath));
  return fs.statAsync(backupPath)
    .then(() => Promise.resolve(backupPath)) // Backup already present.
    .catch(err => fs.copyAsync(gameConf.fileListPath, backupPath)
      .then(() => Promise.resolve(backupPath)));
}

async function getFileList(state: types.IState, gameMode: string): Promise<string[]> {
  return ensureListBackup(state, gameMode)
    .then(backupFilePath => fs.readFileAsync(backupFilePath, { encoding: 'utf-8' }))
    .then(data => Promise.resolve(data.split('\n')));
}

async function validationErrorHandler(api: types.IExtensionApi,
                                      gameConfig: IREEngineConfig,
                                      err: any): Promise<void> {
  const state = api.getState();
  if (err instanceof util.ProcessCanceled) {
    return Promise.resolve();
  }

  if (err instanceof util.UserCanceled) {
    api.sendNotification({
      type: 'info',
      message: 'Operation canceled by user',
      displayMS: 5000,
    });
    return Promise.resolve();
  }

  let profiles: { [profileId: string]: types.IProfile } = util.getSafe(state, ['persistent', 'profiles'], {});
  profiles = Object.keys(profiles).reduce((accum, iter) => {
    if (profiles[iter].gameId === gameConfig.gameMode) {
      accum[iter] = profiles[iter];
    }
    return accum;
  }, {});

  const mods = util.getSafe(state, ['persistent', 'mods', gameConfig.gameMode], {});
  let downloads = util.getSafe(state, ['persistent', 'downloads', 'files'], {});
  downloads = Object.keys(downloads)
    .reduce((accum, iter) => {
      const download: types.IDownload = downloads[iter];
      if (!!download?.game && download.game.includes(gameConfig.gameMode)) {
        accum[iter] = download;
      }
      return accum;
    }, {});
  const gameFileAttachments: IAttachmentData[] = (!!gameConfig.getErrorAttachments)
    ? await gameConfig.getErrorAttachments(err)
    : [];

  const attachments: types.IAttachment[] = [
    {
      id: 'installedMods',
      type: 'data',
      data: {
        persistent: {
          mods: {
            [gameConfig.gameMode]: mods,
          },
          downloads: {
            files: downloads,
          },
          profiles,
        },
      },
      description: 'Mods data',
    },
  ];

  const stagingFolder = selectors.installPathForGame(state, gameConfig.gameMode);
  const qbmsLog: IAttachmentData = {
    filePath: path.join(uniApp.getPath('userData'), 'quickbms.log'),
    description: 'QuickBMS log file',
  };
  const cacheFile: IAttachmentData = {
    filePath: path.join(stagingFolder, CACHE_FILE),
    description: 'Invalidation cache file',
  };

  const fileAttachments: IAttachmentData[] = gameFileAttachments.concat(qbmsLog, cacheFile);
  for (const file of fileAttachments) {
    try {
      await fs.statAsync(file.filePath);
      attachments.push({
        id: path.basename(file.filePath),
        type: 'file',
        data: file.filePath,
        description: file.description,
      });
    } catch (err) {
      // nop
    }
  }

  err['attachLogOnReport'] = true;
  api.showErrorNotification('Validation operation failed', err, { attachments });
}

function testArchive(files, operationPath, archivePath, api, gameId): Promise<string[]> {
  const gameConf: IREEngineConfig = RE_ENGINE_GAMES[gameId];
  if (gameConf === undefined) {
    return Promise.reject();
  }
  return new Promise((resolve, reject) => api.ext.qbmsList({
    gameMode: gameId,
    // Yes - the extract script is used for listing too.
    bmsScriptPath: getStagingFilePath(api, gameId, gameConf.bmsScriptPaths.extract),
    archivePath,
    operationPath,
    qbmsOptions: { wildCards: files },
    quiet: true,
    callback: (err: Error, data: any) => {
      const theFiles: string[] = (data !== undefined)
        ? data.map(file => file.filePath)
        : [];
      return (err !== undefined)
        ? reject(err)
        : (theFiles.length > 0)
          ? resolve(theFiles)
          : reject(new util.NotFound('Files not found'));
    },
  }));
}

async function getGameArchives(api, gameId): Promise<string[]> {
  const gameConf = RE_ENGINE_GAMES[gameId];
  const discoveryPath = getDiscoveryPath(api, gameId);
  if (gameConf === undefined || discoveryPath === undefined) {
    return Promise.reject(new Error('[RE-Wrapper] game not discovered or not an RE engine game'));
  }

  const isValidArchive = (archivePath) => fs.statAsync(archivePath)
    .then(() => Promise.resolve(true))
    .catch(err => Promise.resolve(false));

  if (gameConf.getArchivePaths !== undefined) {
    // Game extension has specified it's own functionality to detect
    //  its own game archives.
    const archives = await gameConf.getArchivePaths();
    const validArchives = await Promise.all(archives.filter(isValidArchive));
    return Promise.resolve(validArchives);
  }

  const isGameArchive = (entry: IEntry) => {
    return (gameConf.isGameArchive !== undefined)
      ? gameConf.isGameArchive(entry.filePath)
      : (path.extname(entry.filePath) === '.pak')
        ? Promise.resolve(true)
        : Promise.resolve(false);
  };
  let gameArchivePaths: string[] = [];
  return new Promise((resolve, reject) => turbowalk(discoveryPath, async (entries: IEntry[]) => {
    return Bluebird.Promise.reduce(entries, (accum, entry) => {
      return isGameArchive(entry)
        .then(res => {
          if (res && entry.filePath.indexOf('backup') === -1) {
            accum.push(entry);
          }
          return accum;
        });
    }, [])
      .then((filtered) => {
        gameArchivePaths = gameArchivePaths.concat(filtered.map(entry => entry.filePath));
        return resolve(gameArchivePaths);
      });
  })
    .catch(err => ['ENOENT', 'ENOTFOUND'].includes(err.code)
      ? resolve([]) : reject(err)));
}

interface IMatchResult {
  matchedAllFiles: boolean;
  archiveMatches: IArchiveMatch[];
}
async function findMatchingArchives(files, discoveryPath, api, gameId): Promise<IMatchResult> {
  let totalMatched = 0;
  const defaultObject: IMatchResult = { archiveMatches: [], matchedAllFiles: false };
  return getGameArchives(api, gameId)
    .then((gameArchives) => {
      gameArchives.sort((lhs, rhs) => {
        // Why is this sort necessary you ask ? it's not; it ensures that
        //  the larger archives which are usually at the directory's root
        //  are used last so that any validation operation's progress does
        //  not appear to "halt" at the very beginning. This is just for
        //  psychological purposes, giving the user somewhat quicker feedback
        //  that Vortex is working and he should just wait.
        const lhsSegments = lhs.split(path.sep);
        const rhsSegments = lhs.split(path.sep);
        return lhsSegments.length !== rhsSegments.length
          ? lhsSegments.length - rhsSegments.length
          : lhs.length - rhs.length;
      });
      return Bluebird.Promise.reduce(gameArchives, async (accum, iter) => {
        if (accum.matchedAllFiles) {
          return Bluebird.Promise.resolve(accum);
        }
        try {
          const matchedFiles: string[] = await testArchive(files, discoveryPath, iter, api, gameId);
          const isSuperseded = accum.archiveMatches.find((arc: IArchiveMatch) => {
            if (arc.isSuperseded) {
              return false;
            }

            if ((arc.matchedFiles.length > matchedFiles.length)
             && (matchedFiles.filter(match => !arc.matchedFiles.includes(match)).length === 0)) {
              return true;
            }
          }) !== undefined;
          if (matchedFiles.length > 0) {
            if (!isSuperseded) {
              totalMatched += matchedFiles.length;
              if (totalMatched === files.length) {
                accum.matchedAllFiles = true;
              }
            }
            const archiveMatch: IArchiveMatch = {
              archivePath: iter,
              matchedFiles,
              isSuperseded: isSuperseded ?? undefined,
            };
            accum.archiveMatches.push(archiveMatch);
          }
        } catch (err) {
          // nop
        }

        return Bluebird.Promise.resolve(accum);
      }, defaultObject);
    });
}

function getDiscoveryPath(api, gameId) {
  const store = api.store;
  const state = store.getState();
  const discovery = util.getSafe(state, ['settings', 'gameMode', 'discovered', gameId], undefined);
  if (discovery?.path === undefined) {
    log('error', 'game was not discovered', gameId);
    return undefined;
  }

  return discovery.path;
}

const FLUFFY_FILES = ['Modmanager.exe'].map(file => file.toLowerCase());
function fluffyManagerTest(files: string[], gameId: string) {
  const matcher = (file: string) => FLUFFY_FILES.includes(file.toLowerCase());
  const supported = ((RE_ENGINE_GAMES[gameId] !== undefined)
    && (files.filter(matcher).length > 0));

  return Bluebird.Promise.resolve({ supported, requiredFiles: [] });
}

function fluffyDummyInstaller(context: types.IExtensionContext) {
  context.api.showErrorNotification('Invalid Mod', 'It looks like you tried to install '
    + 'Fluffy Manager 5000, which is a standalone mod manager and not a mod.\n\n'
    + 'Fluffy Manager and Vortex cannot be used together and doing so will break your game. Please '
    + 'use only one of these apps to manage mods for RE Engine Games.', { allowReport: false });
  return Bluebird.Promise.reject(new util.ProcessCanceled('Invalid mod'));
}

function copyToTemp(filePath) {
  return fs.statAsync(filePath)
    .then(() => fs.ensureDirWritableAsync(QBMS_TEMP_PATH))
    .then(() => fs.copyAsync(filePath, path.join(QBMS_TEMP_PATH, path.basename(filePath))));
}

function removeFromTemp(fileName) {
  const filePath = path.join(QBMS_TEMP_PATH, fileName);
  return fs.removeAsync(filePath)
    .catch(err => (err.code === 'ENOENT')
      ? Bluebird.Promise.resolve()
      : Bluebird.Promise.reject(err));
}

function generateFilteredList(files: string[], state: types.IState, gameMode: string) {
  return fs.ensureDirWritableAsync(QBMS_TEMP_PATH)
    .then(() => getFileList(state, gameMode))
    .then(fileList => {
      const filtered: string[] = [];
      files.forEach(file => {
        const found = fileList.find(entry => entry.indexOf(file) !== -1);
        if (found !== undefined) {
          filtered.push(found);
        }
      });

      return removeFilteredList().then(() =>
        fs.writeFileAsync(FILTERED_LIST, filtered.join('\n')));
    });
}

function removeFilteredList() {
  return fs.removeAsync(FILTERED_LIST)
    .catch(err => (err.code === 'ENOENT')
      ? Bluebird.Promise.resolve()
      : Bluebird.Promise.reject(err));
}

async function invalidate(api: types.IExtensionApi,
                          forceGameConfig?: IREEngineConfig): Promise<void> {
  const state = api.getState();
  const profileId = (forceGameConfig?.gameMode !== undefined)
    ? selectors.lastActiveProfileForGame(state, forceGameConfig.gameMode)
    : undefined;
  const props: IProps = genProps(api, profileId);
  if (props === undefined) {
    log('debug', 'failed to generate props');
    return;
  }
  const { gameConfig } = props;
  const deploymentManifest = await util.getManifest(api, '', gameConfig.gameMode);
  const fileEntries = deploymentManifest.files.map(file => file.relPath.replace(/\\/g, '/'));
  const progress = (message: string, totalProgress: number) => {
    api.sendNotification({
      id: ACTIVITY_INVAL,
      type: 'activity',
      title: 'Invalidating game filepaths - don\'t run the game!',
      message,
      noDismiss: true,
      allowSuppress: false,
      progress: totalProgress,
    });
  };
  try {
    await invalidateFilePaths(api, fileEntries, gameConfig.gameMode, progress);
  } catch (err) {
    const isCanceled = err instanceof util.ProcessCanceled;
    if (!isCanceled) {
      api.showErrorNotification('Invalidation failed', err);
    }
  }

  api.store.dispatch(actions.dismissNotification(ACTIVITY_INVAL));
}

async function revalidate(api: types.IExtensionApi, forceGameConfig?: IREEngineConfig) {
  const state = api.getState();
  const profileId = (forceGameConfig?.gameMode !== undefined)
    ? selectors.lastActiveProfileForGame(state, forceGameConfig.gameMode)
    : undefined;
  const props: IProps = genProps(api, profileId);
  if (props === undefined) {
    log('debug', 'failed to generate props');
    return;
  }

  const { gameConfig } = props;
  const deploymentManifest = await util.getManifest(api, '', gameConfig.gameMode);
  const fileEntries = deploymentManifest.files.map(file => file.relPath.replace(/\\/g, '/'));
  try {
    await revalidateFilePaths(fileEntries.map(entry => murmur3.getMurmur3Hash(entry)), api);
  } catch (err) {
    validationErrorHandler(api, gameConfig, err);
  }

  api.store.dispatch(actions.dismissNotification(ACTIVITY_REVAL));
  return Promise.resolve();
}

async function revalidateFilePaths(hashes, api) {
  const state = api.store.getState();
  const gameId = selectors.activeGameId(state);
  const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[gameId];
  if (gameConfig === undefined) {
    // At this point we know we're attempting to revalidate an RE engine game
    //  but it's perfectly possible for the game extension to NOT have been
    //  loaded (if the game has become undiscovered for whatever reason)
    //  For this reason we're going to log this even and not raise an error.
    log('error', 'failed to revalidate file paths', gameId);
    return Promise.resolve();
  }
  const discoveryPath = getDiscoveryPath(api, gameId);
  if (discoveryPath === undefined) {
    return Promise.reject(new Error('Game is not discovered'));
  }

  const invalCache = cache.getInstance(api);
  return invalCache.findArcKeys(hashes)
    .then(arcMap => {
      if (arcMap === undefined) {
        const err = new Error('Failed to map hashes to their corresponding archive keys');
        return Promise.reject(err);
      }

      let error;
      const keys = Object.keys(arcMap);
      api.sendNotification({
        id: ACTIVITY_REVAL,
        type: 'activity',
        message: 'Revalidating mods',
        noDismiss: true,
        allowSuppress: false,
      });
      return Bluebird.Promise.each(keys, async key => {
        if (arcMap[key].length === 0) {
          return Promise.resolve();
        }

        const legacyPaths = gameConfig.legacyArcNames
          ? Object.keys(gameConfig.legacyArcNames).map(arc => ({
            legacyKey: arc,
            key: gameConfig.legacyArcNames[arc],
            archivePath: path.join(discoveryPath, gameConfig.legacyArcNames[arc]),
          }))
          : undefined;

        const getLegacyKeyPath = () => {
          if (legacyPaths === undefined) {
            return undefined;
          }
          return legacyPaths.find(leg => (leg.legacyKey === key))?.archivePath;
        };

        const gameArchives = await getGameArchives(api, gameId);
        const getKeyPath = () => {
          if (legacyPaths === undefined) {
            return gameArchives.find(arc => path.basename(arc, '.pak') === key);
          } else {
            const segments = key.split(path.sep).filter(seg => !!seg);
            return (segments.length > 1)
              ? legacyPaths.find(arc => arc.key === (key + '.pak'))?.archivePath
              : gameArchives.find(arc => path.basename(arc, '.pak') === key);
          }
        };
        const archivePath = getLegacyKeyPath() || getKeyPath();
        if (archivePath === undefined) {
          return Promise.reject(new Error(`missing game archive - ${key}`));
        }

        return invalCache.getInvalEntries(arcMap[key], key)
          .tap(entries => log('debug', 'revalidating entries:',
            { archiveId: key, totalEntries: entries.length }))
          .then(entries => invalCache.writeInvalEntries(discoveryPath, entries))
          .then(() => new Promise((resolve, reject) => api.ext.qbmsWrite({
            gameMode: gameId,
            quiet: true,
            archivePath,
            bmsScriptPath: getStagingFilePath(api, gameId, gameConfig.bmsScriptPaths.revalidation),
            operationPath: discoveryPath,
            qbmsOptions: {},
            callback: (err: Error, data: any) => {
              error = err;
              return resolve(undefined);
            },
          })))
          .then(() => (error === undefined)
            ? Promise.resolve()
            : (error instanceof util.ProcessCanceled)
              ? Promise.reject(error)
              : Promise.reject(new Error('Failed to re-validate filepaths')))
          .then(() => invalCache.removeOffsets(arcMap[key], key));
      });
    });
}

function addToFileList(state: types.IState, gameMode: string, files: string[]) {
  return getFileList(state, gameMode).then(fileList => {
    const filtered = files.filter(file =>
      fileList.find(cached => cached.indexOf(file) !== -1) === undefined);

    const lines = filtered.reduce((acc, file) => {
      const hashVal = murmur3.getMurmur3Hash(file);
      acc.push(hashVal + ' ' + file);
      return acc;
    }, []);

    const data = (!!fileList[fileList.length - 1])
      ? '\n' + lines.join('\n')
      : lines.join('\n');

    return ensureListBackup(state, gameMode)
      .then(listPath => fs.writeFileAsync(listPath, data,
        { encoding: 'utf-8', flag: 'a' }));
  });
}

async function invalidateFilePaths(api: types.IExtensionApi,
                                   wildCards: string[],
                                   gameMode: string,
                                   progressCB: (message: string, totalProgress: number) => void) {
  const state: types.IState = api.store.getState();
  const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[gameMode];
  if (gameConfig === undefined) {
    // No RE Engine entry for this game.
    log('error', '[RE-Wrapper] no game config for game', gameMode);
    return Promise.reject(new util.ProcessCanceled('game does not support invalidation'));
  }

  const discoveryPath = getDiscoveryPath(api, gameMode);
  if (discoveryPath === undefined) {
    return Promise.reject(new Error('Game is not discovered'));
  }

  progressCB('Scanning game archives...', 5);
  const invalCache = cache.getInstance(api);
  return addToFileList(state, gameMode, wildCards)
    .then(() => findMatchingArchives(wildCards, discoveryPath, api, gameMode))
    .then((result: IMatchResult) => {
      progressCB('Finished archive scan...', 20);
      const archives = result.archiveMatches.filter(arc => arc.isSuperseded !== true);
      const legacyPaths = (gameConfig.legacyArcNames !== undefined)
        ? Object.keys(gameConfig.legacyArcNames).map(arc => ({
          key: gameConfig.legacyArcNames[arc].replace('.pak', ''),
          archivePath: path.join(discoveryPath, gameConfig.legacyArcNames[arc]),
        }))
        : undefined;

      const getLegacyKey = (filePath: string, fallback: string) => {
        if (legacyPaths === undefined) {
          return fallback;
        }
        const legPath = legacyPaths.find(leg =>
          (leg.archivePath.toLowerCase() === filePath.toLowerCase()));
        return legPath?.key || fallback;
      };

      const invalScriptPath = getStagingFilePath(api,
        gameConfig.gameMode, gameConfig.bmsScriptPaths.invalidation);

      const increment = 80 / archives.length;
      return copyToTemp(invalScriptPath)
        .then(() => Promise.all(archives.map((arcMatch, idx) => {
          progressCB(`Invalidating ${arcMatch.archivePath}`, 20 + (idx * increment));
          const fallbackArcKey = path.basename(arcMatch.archivePath, '.pak');
          const arcKey = getLegacyKey(arcMatch.archivePath, fallbackArcKey);
          const data = arcMatch.matchedFiles;
          const qbmsOptions = {
            keepTemporaryFiles: true,
          };
          return generateFilteredList(data, state, gameMode)
            .then(() => new Promise((resolve, reject) => {
              const qbmsOpProps = {
                gameMode,
                quiet: true,
                bmsScriptPath: path.join(QBMS_TEMP_PATH,
                  path.basename(gameConfig.bmsScriptPaths.invalidation)),
                archivePath: arcMatch.archivePath,
                operationPath: discoveryPath,
                qbmsOptions,
                callback: (err: Error, res: any) => {
                  if (err !== undefined) {
                    reject(err);
                  } else {
                    // tslint:disable-next-line: max-line-length
                    return invalCache.readNewInvalEntries(path.join(discoveryPath, 'TEMPORARY_FILE'))
                      .tap((entries) => log('debug', 'invalidating entries',
                        { archiveId: arcKey, totalEntries: entries.length }))
                      .then(entries => invalCache.insertOffsets(entries, arcKey))
                      .then(() => resolve(undefined))
                      .catch(err2 => reject(err2));
                  }
                },
              };
              api.ext.qbmsWrite(qbmsOpProps);
            }));
        })))
        .catch(err => validationErrorHandler(api, gameConfig, err))
        .finally(() => {
          progressCB('Almost finished...', 99);
          return removeFromTemp(path.join(QBMS_TEMP_PATH,
            path.basename(gameConfig.bmsScriptPaths.invalidation)))
            .then(() => removeFilteredList());
        });
    })
    .catch(err => validationErrorHandler(api, gameConfig, err))
    .finally(() => api.store.dispatch(actions.dismissNotification(ACTIVITY_INVAL)));
}

function tryRegistration(func: () => Promise<void>,
                         delayMS: number = 3000,
                         triesRemaining: number = 2) {
  return new Promise((resolve, reject) => {
    return func()
      .then(resolve)
      .catch(err => setTimeout(() => {
        if (triesRemaining === 0) {
          return reject(err);
        }
        return tryRegistration(func, delayMS, --triesRemaining)
          .then(resolve)
          .catch((err2) => reject(err2));
      }, delayMS));
  });
}

function ensureBackUps(api: types.IExtensionApi, gameConfig: IREEngineConfig) {
  const state = api.getState();
  const stagingFolder = selectors.installPathForGame(state, gameConfig.gameMode);
  const toStaging = (filePath: string) => {
    const stagingFilePath = path.join(stagingFolder, path.basename(filePath));
    return fs.statAsync(stagingFilePath)
      .then(() => Promise.resolve()) // Backup already present.
      .catch(err => fs.copyAsync(filePath, stagingFilePath));
  };
  const { extract, invalidation, revalidation } = gameConfig.bmsScriptPaths;
  return Promise.all([extract, invalidation, revalidation, gameConfig.fileListPath].map(toStaging));
}

function addReEngineGame(context: types.IExtensionContext,
                         gameConfig: IREEngineConfig,
                         callback?: (err: Error) => void) {
  const api = context.api;
  const state = api.getState();
  const stagingFolder = selectors.installPathForGame(state, gameConfig.gameMode);
  const getStagingPath = (filePath: string) => path.join(stagingFolder, path.basename(filePath));

  return tryRegistration(() => (api.ext?.qbmsRegisterGame === undefined)
    ? Promise.reject(new REGameRegistrationError(gameConfig.gameMode, 'qbmsRegisterGame is unavailable'))
    : Promise.resolve())
    .then(() => {
      if (RE_ENGINE_GAMES[gameConfig.gameMode] !== undefined) {
        return Promise.resolve();
      }
      return ensureBackUps(context.api, gameConfig)
        .then(() => {
          RE_ENGINE_GAMES[gameConfig.gameMode] = {
            ...gameConfig,
            bmsScriptPaths: {
              extract: getStagingPath(gameConfig.bmsScriptPaths.extract),
              invalidation: getStagingPath(gameConfig.bmsScriptPaths.invalidation),
              revalidation: getStagingPath(gameConfig.bmsScriptPaths.revalidation),
            },
          };
          api.ext.qbmsRegisterGame(gameConfig.gameMode);
          if (callback !== undefined) {
            callback(undefined);
          }

          return Promise.resolve();
        });
    })
    .catch(err => {
      if (callback !== undefined) {
        callback(err);
      } else {
        context.api.showErrorNotification('Re-Engine game registration failed', err);
      }
    });
}

function main(context: types.IExtensionContext) {
  const isReEngineGame = () => {
    const state = context.api.getState();
    const gameMode = selectors.activeGameId(state);
    return (RE_ENGINE_GAMES[gameMode] !== undefined);
  };

  context.requireExtension('quickbms-support');
  context.registerInstaller('fluffyquackmanager', 5,
    fluffyManagerTest, () => fluffyDummyInstaller(context));

  context.registerAPI('addReEngineGame',
    (gameConfig: IREEngineConfig, callback?: (err: Error) => void) => {
      addReEngineGame(context, gameConfig, callback);
    }, { minArguments: 1 });

  context.registerAPI('migrateReEngineGame', (gameConfig: IREEngineConfig,
                                              callback: (err: Error) => void) => {
    // To be used by pre RE Engine wrapper games to migrate away from the old
    //  invalidation cache to the one managed by the wrapper.
    //  What we want to do here is revalidate all filepaths in all
    //  game archives.
    const state = context.api.getState();
    context.api.awaitUI()
      .then(() => addReEngineGame(context, gameConfig, callback))
      .then(() => revalidate(context.api, gameConfig))
      .then(() => {
        InvalidationCache.getInstance(context.api).migrateInvalCache();
        callback(undefined);
      })
      .then(() => {
        const modTypes: { [typeId: string]: string } =
          selectors.modPathsForGame(state, gameConfig.gameMode);
        return context.api.emitAndAwait('purge-mods-in-path',
          gameConfig.gameMode, '', modTypes['']);
      })
      // tslint:disable-next-line: max-line-length
      .then(() => context.api.store.dispatch(actions.setDeploymentNecessary(gameConfig.gameMode, true)))
      .catch(err => callback(err));
  }, { minArguments: 2 });

  context.registerAction('mod-icons', 500, 'savegame', {}, 'Reset Invalidation Cache', () => {
    const state = context.api.getState();
    const activeGameId = selectors.activeGameId(state);
    const stagingFolder = selectors.installPathForGame(state, activeGameId);
    const removeCache = () => fs.removeAsync(path.join(stagingFolder, CACHE_FILE))
      .catch(err => err.code !== 'ENOENT'
        ? context.api.showErrorNotification('Failed to reset cache', err)
        : Promise.resolve());

    const t = context.api.translate;
    context.api.showDialog('question', 'Reset Invalidation Cache', {
      bbcode: t('Please only use this functionality as a last resort - Vortex uses the '
        + 'invalidation cache to keep track of deployed modified files and restore '
        + 'vanilla files when purging your mods. Resetting the cache will cause Vortex '
        + 'to lose track of deployed mods, potentially leaving your game in a broken state.[br][/br][br][/br]'
        + 'Only use this button if you intend to verify file integrity through Steam.'),
    }, [
      { label: 'Close', default: true },
      {
        label: 'View Cache', action: () => util.opn(path.join(stagingFolder, CACHE_FILE))
          .catch(err => null),
      },
      { label: 'Reset Cache', action: () => removeCache() },
    ]);
  }, isReEngineGame);

  context.registerAction('mod-icons', 500, 'savegame', {}, 'Invalidate Paths', () => {
    const store = context.api.store;
    const state = store.getState();
    const gameMode = selectors.activeGameId(state);
    const profile = selectors.activeProfile(state);
    const gameConfig = RE_ENGINE_GAMES[gameMode];
    if (gameConfig === undefined || gameMode !== profile.gameId) {
      // No RE Engine entry for this game.
      log('debug', '[RE-Wrapper] no game config for game', gameMode);
      return;
    }
    revalidate(context.api, gameConfig)
      .then(() => invalidate(context.api, gameConfig));
  }, isReEngineGame);

  let profileChanging: boolean = false;
  context.once(() => {
    context.api.events.on('profile-will-change', (newProfileId) => {
      profileChanging = true;
    });

    context.api.events.on('profile-did-change', (newProfileId) => {
      profileChanging = false;
    });

    context.api.onAsync('will-deploy', () => {
      return revalidate(context.api);
    });

    context.api.events.on('remove-mod', (gameMode, modId) => {
      const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[gameMode];
      if (gameConfig === undefined || profileChanging) {
        return;
      }
      revalidate(context.api, gameConfig);
    });

    context.api.onAsync('did-deploy', () => {
      const state = context.api.getState();
      const profile = selectors.activeProfile(state);
      const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[profile?.gameId];
      if (gameConfig === undefined || profileChanging) {
        return Promise.resolve();
      }

      return invalidate(context.api, gameConfig);
    });

    context.api.onAsync('will-purge', () => {
      return revalidate(context.api);
    });
  });
}

export default main;
