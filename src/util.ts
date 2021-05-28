import path from 'path';
import { selectors, types, util } from 'vortex-api';

import { getSupportMap } from './index';
import { IProps, IREEngineConfig } from './types';

export function genProps(api: types.IExtensionApi, profileId?: string): IProps {
  const state: types.IState = api.getState();
  const profile: types.IProfile = (profileId === undefined)
    ? selectors.activeProfile(state)
    : selectors.profileById(state, profileId);
  if (profile?.gameId === undefined) {
    return undefined;
  }

  const discovery = state.settings.gameMode.discovered[profile.gameId];
  if (discovery?.path === undefined) {
    // Just in case.
    return undefined;
  }

  const gameConfig: IREEngineConfig = getSupportMap()[profile.gameId];
  if (gameConfig === undefined) {
    return undefined;
  }
  const installedMods: { [modId: string]: types.IMod } =
    util.getSafe(state, ['persistent', 'mods', profile.gameId], {});
  const enabledMods = Object.keys(installedMods)
    .filter(id => util.getSafe(profile, ['modState', id, 'enabled'], false))
    .reduce((accum, id) => {
      accum[id] = installedMods[id];
      return accum;
    }, {});
  return { state, profile, gameConfig, enabledMods, installedMods };
}

export function getStagingFilePath(api: types.IExtensionApi,
                                   gameId: string,
                                   bmsScriptPath: string) {
  const state = api.getState();
  const stagingFolder = selectors.installPathForGame(state, gameId);
  return path.join(stagingFolder, path.basename(bmsScriptPath));
}
