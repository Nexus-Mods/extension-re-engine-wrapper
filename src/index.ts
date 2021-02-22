import * as Bluebird from 'bluebird';
import { app, remote } from 'electron';
import path from 'path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';

import turbowalk, { IEntry } from 'turbowalk';

import cache from './cache';
import { CACHE_FILE } from './common';
import murmur3 from './murmur3';
import { IArchiveMatch, IDeployment, IREEngineConfig,
  IREEngineGameSupport, REGameRegistrationError } from './types';

const uniApp = app || remote.app;

const QBMS_TEMP_PATH = path.join(uniApp.getPath('userData'), 'temp', 'qbms');
const RE_ENGINE_GAMES: IREEngineGameSupport = {};

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

function testArchive(files, operationPath, archivePath, api, gameId): Promise<string[]> {
  const gameConf: IREEngineConfig = RE_ENGINE_GAMES[gameId];
  if (gameConf === undefined) {
    return Promise.reject();
  }
  return new Promise((resolve, reject) => api.ext.qbmsList({
    gameMode: gameId,
    // Yes - the extract script is used for listing too.
    bmsScriptPath: gameConf.bmsScriptPaths.extract,
    archivePath,
    operationPath,
    qbmsOptions: { wildCards: files },
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

async function findMatchingArchives(files, discoveryPath, api, gameId): Promise<IArchiveMatch[]> {
  return getGameArchives(api, gameId)
    .then((gameArchives) => {
      return Bluebird.Promise.reduce(gameArchives, async (accum, iter) => {
        try {
          const matchedFiles: string[] = await testArchive(files, discoveryPath, iter, api, gameId);
          if (matchedFiles.length > 0) {
            const archiveMatch: IArchiveMatch = {
              archivePath: iter,
              matchedFiles,
            };
            accum.push(archiveMatch);
          }
        } catch (err) {
          // nop
        }
        return Promise.resolve(accum);
      }, []);
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

const FLUFFY_FILES = ['fmodex64.dll', 'Modmanager.exe'];
function fluffyManagerTest(files, gameId) {
  const matcher = (file => FLUFFY_FILES.includes(file));
  const supported = ((RE_ENGINE_GAMES[gameId] !== undefined)
                 && (files.filter(matcher).length > 0));

  return Promise.resolve({ supported, requiredFiles: FLUFFY_FILES });
}

function fluffyDummyInstaller(context) {
  return async (files: string[]) => {
    context.api.showErrorNotification('Invalid Mod', 'It looks like you tried to install '
    + 'Fluffy Manager 5000, which is a standalone mod manager and not a mod for Resident Evil 2.\n\n'
    + 'Fluffy Manager and Vortex cannot be used together and doing so will break your game. Please '
    + 'use only one of these apps to manage mods for Resident Evil 2.', { allowReport: false });
    return Promise.reject(new util.ProcessCanceled('Invalid mod'));
  };
}

function copyToTemp(filePath) {
  return fs.statAsync(filePath)
    .then(() => fs.ensureDirAsync(QBMS_TEMP_PATH))
    .then(() => fs.copyAsync(filePath, path.join(QBMS_TEMP_PATH, path.basename(filePath))));
}

function removeFromTemp(fileName) {
  const filePath = path.join(QBMS_TEMP_PATH, fileName);
  return fs.removeAsync(filePath)
    .catch(err => (err.code === 'ENOENT')
      ? Promise.resolve()
      : Promise.reject(err));
}

function generateFilteredList(files: string[], state: types.IState, gameMode: string) {
  return fs.ensureDirAsync(QBMS_TEMP_PATH)
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
      ? Promise.resolve()
      : Promise.reject(err));
}

function filterOutInvalidated(wildCards, stagingFolder): Bluebird<string[]> {
  const entries = wildCards.map(entry => ({
    hash: murmur3.getMurmur3Hash(entry),
    filePath: entry,
  }));
  return cache.findArcKeys(stagingFolder, entries.map(entry => entry.hash))
    .then(arcMap => {
      if (arcMap === undefined) {
        // None of the entries have been invalidated.
        return Promise.resolve(wildCards);
      }

      // Look up existing invalidations.
      const mapKeys = Object.keys(arcMap).filter(key =>
        entries.find(entry =>
          arcMap[key].indexOf(entry.hash) !== -1) !== undefined);

      let flat = [];
      mapKeys.forEach(key => {
        flat = flat.concat(arcMap[key]);
      });

      const filtered = entries.reduce((accumulator, entry) => {
        if (flat.find(mapEntry => mapEntry === entry.hash) === undefined) {
            accumulator.push(entry.filePath);
        }
        return accumulator;
      }, []);

      return filtered.length > 0
        ? Bluebird.Promise.resolve(filtered)
        : Bluebird.Promise.reject(new Error('All entries invalidated'));
    });
}

async function revalidate(context: types.IExtensionContext, gameConfig?: IREEngineConfig) {
  const store = context.api.store;
  const state = store.getState();
  const activeProfile = selectors.activeProfile(state);
  if (gameConfig === undefined) {
    gameConfig = RE_ENGINE_GAMES[activeProfile?.gameId];
    if (gameConfig === undefined) {
      return Promise.resolve();
    }
  }

  const stagingFolder = selectors.installPathForGame(state, activeProfile.gameId);
  const installedMods = util.getSafe(state, ['persistent', 'mods', activeProfile.gameId], {});
  const mods = Object.keys(installedMods);
  let fileEntries: string[] = [];
  return Bluebird.Promise.each(mods, mod => {
    const modFolder = path.join(stagingFolder, mod);
    return turbowalk(modFolder, entries => {
      const filtered = entries.filter(file => !file.isDirectory)
                              .map(entry => entry.filePath.replace(modFolder + path.sep, ''));
      fileEntries = fileEntries.concat(filtered);
    })
    .catch(err => ['ENOENT', 'ENOTFOUND'].includes(err.code)
      ? Promise.resolve() : Promise.reject(err));
  })
  .then(() => {
    const unique = [...new Set(fileEntries)];
    const wildCards = unique.map(fileEntry => fileEntry.replace(/\\/g, '/'));
    return revalidateFilePaths(wildCards.map(entry =>
      murmur3.getMurmur3Hash(entry)), context.api);
  })
    .catch(util.UserCanceled, () => context.api.sendNotification({
      type: 'info',
      message: 'Re-validation canceled by user',
      displayMS: 5000,
    }))
  .catch(err => null)
  .finally(() => {
    store.dispatch(actions.dismissNotification(ACTIVITY_REVAL));
    return Promise.resolve();
  });
}

async function revalidateFilePaths(hashes, api) {
  const state = api.store.getState();
  const gameId = selectors.activeGameId(state);
  const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[gameId];
  if (gameConfig === undefined) {
    return Promise.reject(new Error('failed to revalidate file paths'));
  }
  const discoveryPath = getDiscoveryPath(api, gameId);
  if (discoveryPath === undefined) {
    return Promise.reject(new Error('Game is not discovered'));
  }

  const stagingFolder = selectors.installPathForGame(state, gameId);
  return cache.findArcKeys(stagingFolder, hashes)
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

        const gameArchives = await getGameArchives(api, gameId);
        const archivePath = gameArchives.find(arc => path.basename(arc, '.pak') === key);
        if (archivePath === undefined) {
          return Promise.reject(new Error(`missing game archive - ${key}`));
        }

        return cache.getInvalEntries(stagingFolder, arcMap[key], key)
          .then(entries => cache.writeInvalEntries(discoveryPath, entries))
          .then(() => new Promise((resolve, reject) => api.ext.qbmsWrite({
            gameMode: gameId,
            archivePath,
            bmsScriptPath: gameConfig.bmsScriptPaths.revalidation,
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
          .then(() => cache.removeOffsets(stagingFolder, arcMap[key], key));
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
                                   force: boolean = false) {
  const notifId = 're_engine_missing_files';
  const state: types.IState = api.store.getState();
  const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[gameMode];
  if (gameConfig === undefined) {
    // No RE Engine entry for this game.
    log('error', '[RE-Wrapper] no game config for game', gameMode);
    return Promise.reject(new util.ProcessCanceled('game does not support invalidation'));
  }

  const reportIncompleteList = () => {
    const notifications = util.getSafe(state, ['session', 'notifications', 'notifications'], []);
    if (notifications.find(notif => notif.id === notifId) === undefined) {
      api.showErrorNotification('Missing filepaths in game archives',
      'Unfortunately Vortex cannot install this mod correctly as it seems to include one or more '
      + 'unrecognized files.<br/><br/>'
      + 'This can happen when:<br/>'
      + '1. Your game archives do not include the files required for this mod to work (Possibly missing DLC)<br/>'
      + '2. The mod author has packed his mod incorrectly and has included non-mod files such as readmes, screenshots, etc. '
      + '(In which case you don\'t have to worry - the mod should still work) <br/><br/>'
      + 'To report this issue, please use the feedback system and make sure you attach Vortex\'s latest log file '
      + 'so we can review the missing files',
      { isBBCode: true, allowReport: false });
    }

    return Promise.resolve();
  };

  // For the invalidation logic to work correctly all
  //  wildCards MUST belong to the same game archive/mod.
  const discoveryPath = getDiscoveryPath(api, gameMode);
  if (discoveryPath === undefined) {
    return Promise.reject(new Error('Game is not discovered'));
  }

  const stagingFolder = selectors.installPathForGame(state, gameMode);
  const filterPromise = (force)
    ? Bluebird.Promise.resolve(wildCards)
    : filterOutInvalidated(wildCards, stagingFolder);

  api.sendNotification({
    id: ACTIVITY_INVAL,
    type: 'activity',
    message: 'Invalidating game filepaths',
    noDismiss: true,
    allowSuppress: false,
  });

  return filterPromise.then(filtered => addToFileList(state, gameMode, filtered)
    .then(() => findMatchingArchives(filtered, discoveryPath, api, gameMode))
    .then((archives: IArchiveMatch[]) => {
      if (archives.length === 0) {
        // Couldn't find a matching archive. There's is a high chance
        //  we're installing the same mod and the mod author may have
        //  included a .txt file or some other unnecessary file inside
        //  the mod's natives folder, in which case this is not a problem
        //  - log the missing files and keep going.
        const invalidationsExist = filtered.length !== wildCards.length;
        log(invalidationsExist
          ? 'warn' : 'error', 'Missing filepaths in game archive', filtered.join('\n'));
        return (invalidationsExist)
          ? Promise.resolve()
          : Promise.reject(new util.NotFound('Failed to match mod files to game archives'));
      }

      return copyToTemp(gameConfig.bmsScriptPaths.invalidation)
        .then(() => Promise.all(archives.map(arcMatch => {
          const arcKey = path.basename(arcMatch.archivePath, '.pak');
          const data = arcMatch.matchedFiles;
          const qbmsOptions = {
            keepTemporaryFiles: true,
          };
          return generateFilteredList(data, state, gameMode)
          .then(() => new Promise((resolve, reject) => {
            const qbmsOpProps = {
              gameMode,
              bmsScriptPath: path.join(QBMS_TEMP_PATH,
                path.basename(gameConfig.bmsScriptPaths.invalidation)),
              archivePath: arcMatch.archivePath,
              operationPath: discoveryPath,
              qbmsOptions,
              callback: (err: Error, res: any) => {
                if (err !== undefined) {
                  reject(err);
                } else {
                  return cache.readNewInvalEntries(path.join(discoveryPath, 'TEMPORARY_FILE'))
                    .then(entries => cache.insertOffsets(stagingFolder, entries, arcKey))
                    .then(() => resolve(undefined));
                }
              },
            };
            api.ext.qbmsWrite(qbmsOpProps);
          }));
      })))
      .catch(err => {
        if (err instanceof util.ProcessCanceled
         || err.message.includes('All entries invalidated')) {
          return Promise.resolve();
        }

        if (err instanceof util.NotFound) {
          return (force) ? Promise.resolve() : reportIncompleteList();
        }

        if (err instanceof util.UserCanceled) {
          api.sendNotification({
            type: 'info',
            message: 'Invalidation canceled by user',
            displayMS: 5000,
          });
          return Promise.resolve();
        }

        api.showErrorNotification('invalidation failed', err);
      })
      .finally(() => {
        api.store.dispatch(actions.dismissNotification(ACTIVITY_INVAL));
        return removeFromTemp(path.join(QBMS_TEMP_PATH,
          path.basename(gameConfig.bmsScriptPaths.invalidation)))
          .then(() => removeFilteredList());
      });
    }));
}

function tryRegistration(func: () => Promise<void>,
                         delayMS: number = 3000,
                         triesRemaining: number = 2)  {
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

function main(context) {
  context.requireExtension('quickbms-support');
  context.registerInstaller('fluffyquackmanager', 20,
    fluffyManagerTest, fluffyDummyInstaller(context));

  context.registerAPI('addReEngineGame', (gameConfig: IREEngineConfig, callback?: (err: Error) => void) => {
    const api = context.api;
    const state = api.getState();
    const stagingFolder = selectors.installPathForGame(state, gameConfig.gameMode);
    const fileList = path.join(stagingFolder, path.basename(gameConfig.fileListPath));
    fs.statAsync(fileList)
      .then(() => Promise.resolve()) // Backup already present.
      .catch(err => fs.copyAsync(gameConfig.fileListPath, fileList));

    tryRegistration(() => (api.ext?.qbmsRegisterGame === undefined)
      ? Promise.reject(new REGameRegistrationError(gameConfig.gameMode, 'qbmsRegisterGame is unavailable'))
      : Promise.resolve())
    .then(() => {
      RE_ENGINE_GAMES[gameConfig.gameMode] = gameConfig;
      api.ext.qbmsRegisterGame(gameConfig.gameMode);
      if (callback !== undefined) {
        callback(undefined);
      }
    })
    .catch(err => {
      if (callback !== undefined) {
        callback(err);
      } else {
        context.api.showErrorNotification('Re-Engine game registration failed', err);
      }
    });
  }, { minArguments: 1 });

  context.registerAPI('migrateReEngineGame', (gameConfig: IREEngineConfig,
                                              callback: (err: Error) => void) => {
    // To be used by pre RE Engine wrapper games to migrate away from the old
    //  invalidation cache to the one managed by the wrapper.
    //  What we want to do her is revalidate all filepaths in all
    //  game archives.
    const state = context.api.store.getState();
    const staging = selectors.installPathForGame(state, gameConfig.gameMode);
    revalidate(context, gameConfig)
      .then(() => {
        cache.migrateInvalCache(staging);
        callback(undefined);
      })
      .catch(err => callback(err));
  }, { minArguments: 2 });

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

    const stagingFolder = selectors.installPathForGame(state, gameConfig.gameMode);
    const installedMods = util.getSafe(state, ['persistent', 'mods', gameMode], {});
    const modKeys = Object.keys(installedMods);
    const enabled = modKeys.reduce((accum, iter) => {
      if (util.getSafe(profile, ['modState', iter, 'enabled'], false)) {
        accum.push(iter);
      }
      return accum;
    }, []);
    return Promise.all(enabled.map(async mod => {
      const modFolder = path.join(stagingFolder, mod);
      let entries: IEntry[] = [];
      await turbowalk(modFolder, fileEntries => {
        const filtered = fileEntries.filter(file => !file.isDirectory);
        entries = entries.concat(filtered);
      }).catch(err => {
        if (['ENOENT', 'ENOTFOUND'].includes(err.code)) {
          // Missing mod installation folder ? Inform user and continue.
          context.api.showErrorNotification('Missing mod installation folder',
          'A mod\'s installation folder is missing or is still being extracted/removed.'
        + 'Please ensure that the mod installation directory "{{modDir}}" exists.',
          { replace: { modDir: modFolder }, allowReport: false });
          return Promise.resolve();
        } else {
          context.api.showErrorNotification('invalidation failed', err);
        }
      });
      const relFilePaths = entries.map(entry => entry.filePath.replace(modFolder + path.sep, ''));
      const wildCards = relFilePaths.map(fileEntry => fileEntry.replace(/\\/g, '/'));
      return invalidateFilePaths(context.api, wildCards, gameMode, true)
        .then(() => store.dispatch(actions.setDeploymentNecessary(gameMode, true)))
        .catch(err => (err instanceof util.ProcessCanceled)
          ? Promise.resolve()
          : Promise.reject(err));
    }));
  }, () => {
    const state = context.api.store.getState();
    const gameMode = selectors.activeGameId(state);
    return (RE_ENGINE_GAMES[gameMode] !== undefined);
  });

  let profileChanging: boolean = false;
  context.once(() => {
    context.api.events.on('profile-will-change', (newProfileId) => {
      profileChanging = true;
    });
    context.api.events.on('profile-did-change', (newProfileId) => {
      profileChanging = false;
    });
    context.api.events.on('did-deploy', () => {
      const store = context.api.store;
      const state = store.getState();
      const profile = selectors.activeProfile(state);
      const gameConfig: IREEngineConfig = RE_ENGINE_GAMES[profile?.gameId];
      if (gameConfig === undefined || profileChanging) {
        return;
      }

      const stagingFolder = selectors.installPathForGame(state, profile.gameId);

      const mods: { [id: string]: types.IMod } =
        util.getSafe(state, ['persistent', 'mods', profile.gameId], {});
      const enabledMods: types.IMod[] = Object.keys(mods)
        .filter(modId => util.getSafe(profile, ['modState', modId, 'enabled'], false))
        .map(modId => mods[modId]);

      return Bluebird.Promise.each(enabledMods, async mod => {
        const modFolder = path.join(stagingFolder, mod.installationPath);
        let modEntries: string[] = [];
        try {
          await turbowalk(modFolder, entries => {
            const filtered = entries.filter(file => !file.isDirectory);
            modEntries = modEntries.concat(filtered.map(entry => entry.filePath));
          });
        } catch (err) {
          return ['ENOENT', 'ENOTFOUND'].includes(err.code)
            ? Promise.resolve() : Promise.reject(err);
        }
        const relFilePaths = modEntries.map(entry => entry.replace(modFolder + path.sep, ''));
        const wildCards = relFilePaths.map(fileEntry => fileEntry.replace(/\\/g, '/'));
        return invalidateFilePaths(context.api, wildCards, gameConfig.gameMode)
          .catch(err => {
            if (err instanceof util.ProcessCanceled) {
              return Promise.resolve();
            }
            context.api.showErrorNotification('invalidation failed', err);
          });
      })
      .finally(() => {
        store.dispatch(actions.dismissNotification(ACTIVITY_INVAL));
        return Promise.resolve();
      });
    });

    context.api.events.on('purge-mods', () => {
      revalidate(context);
    });
  });
}

export default main;
