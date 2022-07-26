import { types } from 'vortex-api';

export type ValidationType = 'invalidation' | 'revalidation';
export interface IValidationErrorInfo {
  gameMode: string;
  message: string;
  filePaths: string[];
  validationType: ValidationType;
}

export interface IProps {
  state: types.IState;
  installedMods: { [modId: string]: types.IMod };
  enabledMods: { [modId: string]: types.IMod };
  profile: types.IProfile;
  gameConfig: IREEngineConfig;
}

// The invalidation cache itself which we serialize to file.
export interface ICache { [archiveId: string]: ICacheEntry[] };

// Cache entry as stored inside our invalidation cache.
export interface ICacheEntry {
  hashVal: number;
  data: {
      offset: string;
      lowercase: string;
      uppercase: string;
  };
}

// List entry as parsed from the .list file.
export interface IListEntry {
  hash: number;
  offset: string;
  lowercase: string;
  uppercase: string;
}

export class InvalidationCacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidationCacheError';
  }
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

  // Latest RT update from Capcom appears to be using a different
  //  seed value for each filepath, making it quite difficult
  //  to generate the correct expected hash value to compare against.
  //  Fortunately the modding community convinced them to provide the
  //  non-RT game version as a beta branch which is what this property
  //  is for. It ensures that the Vortex Steam File Downloader uses
  //  the correct codebase when restoring files.
  steamBranch?: string;

  // Same as above, we need to provide the non-rt depot id.
  depotIds?: number[];

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
  isSuperseded?: boolean;
}

export interface IDeployment {
  [modType: string]: types.IDeployedFile[];
}

export interface ISteamKitParameters {
  Username?: string;
  Password?: string;
  RememberPassword?: boolean;
  ManifestOnly?: boolean;
  CellId?: number;

  // Files need to be separated by /r or /n
  FileList?: string;
  InstallDirectory?: string;
  VerifyAll?: boolean;
  MaxServers?: number;
  MaxDownloads?: number;
  LoginId?: number;

  // Steam app id
  AppId?: number;

  PubFile?: string;
  UgcId?: string;
  Branch?: string;
  BetaBranchPassword?: string;
  DepotIdList?: number[];
  ManifestIdList?: number[];
}