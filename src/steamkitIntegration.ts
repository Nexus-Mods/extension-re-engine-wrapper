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
    ? 'Vortex has detected an error with your game files, you will be unable to mod the game until this is resolved.{{bl}}'
    : '';
  const showDialog = api.showDialog?.('question', 'Verify Integrity of Steam Game Files', {
    bbcode: addendum + t(`${addendum}` + 'Due to the complexity of modding RE Engine games, it is possible '
      + 'to experience game file corruption or mismatches.{{bl}}'
      + 'This can be caused when other mod managers (such as "Fluffy Manager 5000") are used alongside '
      + 'Vortex, or when the game updates and overwrites modded files.{{bl}}'
      + 'Vortex can fix these issues by downloading and restoring the correct game files automatically '
      + 'from Steam. Click "Verify Game Files" below to run this process.{{bl}}'
      + 'Note: Most of the games files are over 20GB, meaning file restoration can take a while. If you choose to restore '
      + 'any files, please DO NOT interrupt the process by closing Vortex.', {
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
