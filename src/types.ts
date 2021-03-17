import { types } from 'vortex-api';

export type ValidationType = 'invalidation' | 'revalidation';
export interface IValidationErrorInfo {
  gameMode: string;
  message: string;
  filePaths: string[];
  validationType: ValidationType;
}

export class ValidationError extends Error {
  private mAffectedGame: string;
  private mValidationType: ValidationType;
  private mFilePaths: string;
  constructor(validationError: IValidationErrorInfo) {
    super(`Failed ${validationError.validationType}: ${validationError.message}`);
    this.mValidationType = validationError.validationType;
    this.mAffectedGame = validationError.gameMode;
    const isTruncated: boolean = (validationError.filePaths.length > 40);
    const filePaths: string[] = (isTruncated)
      ? validationError.filePaths.slice(validationError.filePaths.length - 40)
      : validationError.filePaths;

    if (isTruncated) {
      filePaths.push('truncated...');
    }

    this.mFilePaths = filePaths.join('\n');
  }

  public get validationType(): ValidationType {
    return this.mValidationType;
  }

  public get filePaths(): string {
    return this.mFilePaths;
  }

  public get affectedGame(): string {
    return this.mAffectedGame;
  }
}

export class REGameRegistrationError extends Error {
  constructor(gameMode: string, message: string) {
    super(`RE-Engine-Wrapper Failed to register ${gameMode}: ${message}`);
  }
}

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

  // Used during re-engine-wrapper cache migration.
  //  Do not use this for any other games besides RE2 and DMC5
  legacyArcNames?: { [arcKey: string]: string };

  // Abs path to the game's cache file if a custom location
  //  is needed. By default the cache's path is inside the staging
  //  folder.
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
