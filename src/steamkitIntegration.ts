import Bluebird from 'bluebird';
import { selectors, types, util } from 'vortex-api';

import { ISteamKitParameters, IREEngineConfig } from './types';

function convertBluebirdToPromise(bluebird: Bluebird<any> | undefined): Promise<any> {
  if (bluebird) {
    return new Promise((resolve, reject) => {
      bluebird.then(resolve).catch(reject);
    });
  }
  return Promise.resolve();
}

export function isSteamKitAvaliable(api: types.IExtensionApi): boolean {
  return !!api.ext.steamkitVerifyFileIntegrity;
}

export function showVerifyIntegrityDialog(api: types.IExtensionApi, validationError?: boolean): Promise<types.IDialogResult> {
  const t = api.translate;
  const addendum = validationError
    ? 'A validation error has just occurred - this will block you from modding the game further until it is resolved.{{bl}}'
    : '';
  const showDialog = api.showDialog?.('question', 'Verify Integrity of Steam Game Files', {
    bbcode: t('Due to the modding pattern of RE Engine games, it\'s fairly common to '
          + 'experience game archive corruption or potential mismatch between what '
          + 'mods are installed, and what Vortex is expecting to be installed.{{bl}}'
          + 'This issue is usually caused when using other modding tools such as "Fluffy Manager 5000" '
          + 'alongside Vortex, or simply when the game updates and the modded archives are overwritten.{{bl}}'
          + 'Vortex can fix any potential corruption and resolve any mod mismatches by restoring '
          + 'the game files using the Steam File Downloader extension (which has been auto-installed for you){{bl}}'
          + addendum
          + 'Please note: most of the game\'s archives are generally over 20GB. Archive restoration process may take '
          + 'a while depending on your internet connection. If you choose to restore any files, please DO NOT interrupt '
          + 'the process!', {
            replace: {
              bl: '[br][/br][br][/br]',
            }
          }),
  }, [
    { label: 'Cancel' },
    { label: 'Verify Game Files' }
  ]);
  return convertBluebirdToPromise(showDialog);
}

export function runFileVerification(api: types.IExtensionApi, gameConfig: IREEngineConfig, cb?: (err: Error) => void) {
  const state = api.getState();
  if (!!api.ext.steamkitVerifyFileIntegrity) {
    const game = util.getGame(gameConfig.gameMode);
    const discovery = selectors.discoveryByGame(state, gameConfig.gameMode);
    const lookUpId = (obj: any) => {
      if (!obj) {
        return undefined;
      }
      const key = Object.keys(obj).find(key => key.toLowerCase() === 'steamappid');
      return key ? obj[key] : undefined;
    };
    const parameters: ISteamKitParameters = {
      AppId: (lookUpId(game?.details) || lookUpId(game?.environment)),
      VerifyAll: true,
      ManifestOnly: true,
      InstallDirectory: discovery.path,
      Branch: gameConfig.steamBranch,
      DepotIdList: gameConfig.depotIds,
    };
    api.ext.steamkitVerifyFileIntegrity(parameters, gameConfig.gameMode, cb);
  }
}
