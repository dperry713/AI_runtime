/**
 * Shared, dependency-free Windows Credential Manager protocol contracts.
 * Kept in the types layer so secrets never imports the sandbox implementation.
 */
export interface CredentialSpec {
  readonly targetName: string;
  readonly credentialBlob: string;
  readonly userName?: string | undefined;
  readonly comment?: string | undefined;
  readonly persist?: 'session' | 'enterprise' | 'local_machine' | undefined;
}

export interface CredentialResult {
  readonly targetName: string;
  readonly success: boolean;
  readonly message: string;
}

export interface CredentialListEntry {
  readonly targetName: string;
  readonly userName: string | undefined;
  readonly comment: string | undefined;
}

export type CmRequest =
  | { readonly op: 'cm_write'; readonly credential: CredentialSpec }
  | { readonly op: 'cm_read'; readonly targetName: string }
  | { readonly op: 'cm_delete'; readonly targetName: string }
  | { readonly op: 'cm_list'; readonly filter?: string | undefined };

export type CmResponse =
  | { readonly type: 'cm_credential_written'; readonly version: number; readonly targetName: string; readonly success: boolean }
  | { readonly type: 'cm_credential_read'; readonly version: number; readonly targetName: string; readonly credentialBlob: string | undefined; readonly userName: string | undefined; readonly found: boolean }
  | { readonly type: 'cm_credential_deleted'; readonly version: number; readonly targetName: string; readonly success: boolean }
  | { readonly type: 'cm_credentials_listed'; readonly version: number; readonly credentials: readonly CredentialListEntry[] }
  | { readonly type: 'error'; readonly version: number; readonly code: string; readonly message: string };

export interface CredentialManagerPort {
  readCredential(targetName: string): Promise<{
    readonly credentialBlob: string | undefined;
    readonly userName: string | undefined;
    readonly found: boolean;
  }>;
  writeCredential(spec: CredentialSpec): Promise<CredentialResult>;
}
