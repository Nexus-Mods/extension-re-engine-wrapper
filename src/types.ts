import { types } from 'vortex-api';

export interface IREEngineConfig {
  // The Nexus Mods domain name for this game.
  gameMode: string;

  // Abs path to all relevant BMS scripts required
  //  for QBMS operations.
  bmsScriptPaths: {
    invalidation: string;
    revalidation: string;
    extract: string;
  };

  fileListPath: string;

  // Abs path to the game's cache file
  cachePath?: string;

  // Game extensions are able to provide file paths to the
  //  game's archives which should be taken into consideration.
  getArchivePaths?: () => Promise<string[]>;

  // Gives game extensions the ability to attach additional
  //  data to any QBMS error report if needed.
  getErrorAttachments?: (err: Error) => Promise<IAttachmentData[]>;

  // Extensions are able to define a predicate to confirm if
  //  the specified archive is indeed a game archive.
  isGameArchive?: (filePath: string) => Promise<boolean>;
}

export interface IAttachmentData {
  filePath: string;
  description: string;
}

export interface IREEngineGameSupport {
  [gameId: string]: IREEngineConfig;
}

export interface IArchiveMatch {
  archivePath: string;
  matchedFiles: string[];
}

export interface IDeployment {
  [modType: string]: types.IDeployedFile[];
}
