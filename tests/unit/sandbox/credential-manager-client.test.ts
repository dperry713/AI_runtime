/**
 * Unit tests for CredentialManagerClient (Phase W3 - Windows Credential Manager).
 */

import { describe, expect, it } from 'vitest';
import { AirError } from '../../../src/errors/index.js';
import {
  CredentialManagerClient,
  buildMasterKeyTargetName,
  type CmRequest,
  type CmResponse,
  type CredentialSpec,
} from '../../../src/sandbox/credential-manager-client.js';

function makeMockHandler(responses: CmResponse[]) {
  let index = 0;
  return (_request: CmRequest): Promise<CmResponse> => {
    void _request;
    const response = responses[index] as CmResponse;
    index += 1;
    return Promise.resolve(response);
  };
}

describe('CredentialManagerClient', () => {
  it('writeCredential sends write request and returns result', async () => {
    const spec: CredentialSpec = {
      targetName: 'AIR:Test:Key1',
      credentialBlob: 'secret-blob',
      userName: 'AIR_User',
    };

    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'cm_credential_written',
          version: 1,
          targetName: 'AIR:Test:Key1',
          success: true,
        },
      ]),
    });

    const result = await client.writeCredential(spec);
    expect(result).toEqual({
      targetName: 'AIR:Test:Key1',
      success: true,
      message: 'Credential written successfully',
    });
  });

  it('writeCredential throws AirError on error response', async () => {
    const spec: CredentialSpec = {
      targetName: 'AIR:Test:Key1',
      credentialBlob: 'secret-blob',
    };

    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'CRED_WRITE_FAILED',
          message: 'Access is denied',
        },
      ]),
    });

    await expect(client.writeCredential(spec)).rejects.toThrow(AirError);
  });

  it('writeCredential throws AirError on unexpected response', async () => {
    const spec: CredentialSpec = { targetName: 'AIR:Test:Key1', credentialBlob: 'blob' };
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'cm_credential_deleted',
          version: 1,
          targetName: 'AIR:Test:Key1',
          success: true,
        } as unknown as CmResponse,
      ]),
    });

    await expect(client.writeCredential(spec)).rejects.toThrow(AirError);
  });

  it('readCredential returns blob when found', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'cm_credential_read',
          version: 1,
          targetName: 'AIR:Test:Key1',
          credentialBlob: 'my-secret-data',
          userName: 'AIR_User',
          found: true,
        },
      ]),
    });

    const result = await client.readCredential('AIR:Test:Key1');
    expect(result.found).toBe(true);
    expect(result.credentialBlob).toBe('my-secret-data');
    expect(result.userName).toBe('AIR_User');
  });

  it('readCredential returns found=false when credential does not exist', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'cm_credential_read',
          version: 1,
          targetName: 'AIR:Test:NonExistent',
          credentialBlob: undefined,
          userName: undefined,
          found: false,
        },
      ]),
    });

    const result = await client.readCredential('AIR:Test:NonExistent');
    expect(result.found).toBe(false);
    expect(result.credentialBlob).toBeUndefined();
  });

  it('readCredential throws on error response', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'CRED_READ_FAILED',
          message: 'Decryption failed',
        },
      ]),
    });

    await expect(client.readCredential('AIR:Test:Key1')).rejects.toThrow(AirError);
  });

  it('deleteCredential sends delete request and returns boolean', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'cm_credential_deleted',
          version: 1,
          targetName: 'AIR:Test:Key1',
          success: true,
        },
      ]),
    });

    const deleted = await client.deleteCredential('AIR:Test:Key1');
    expect(deleted).toBe(true);
  });

  it('deleteCredential throws on error response', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'CRED_DELETE_FAILED',
          message: 'Target not found',
        },
      ]),
    });

    await expect(client.deleteCredential('AIR:Test:Key1')).rejects.toThrow(AirError);
  });

  it('listCredentials returns list of entries', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'cm_credentials_listed',
          version: 1,
          credentials: [
            { targetName: 'AIR:Key1', userName: 'User1', comment: undefined },
            { targetName: 'AIR:Key2', userName: 'User2', comment: undefined },
          ],
        },
      ]),
    });

    const list = await client.listCredentials('AIR:*');
    expect(list).toHaveLength(2);
    expect(list[0]?.targetName).toBe('AIR:Key1');
    expect(list[1]?.targetName).toBe('AIR:Key2');
  });

  it('listCredentials throws on error response', async () => {
    const client = new CredentialManagerClient({
      mockHandler: makeMockHandler([
        {
          type: 'error',
          version: 1,
          code: 'CRED_LIST_FAILED',
          message: 'Enumeration error',
        },
      ]),
    });

    await expect(client.listCredentials()).rejects.toThrow(AirError);
  });

  it('buildMasterKeyTargetName formats scoped hash', () => {
    const target1 = buildMasterKeyTargetName('C:\\AIR\\vault');
    const target2 = buildMasterKeyTargetName('C:\\AIR\\vault');
    const target3 = buildMasterKeyTargetName('C:\\AIR\\other-vault');

    expect(target1.startsWith('AIR:MasterKey:')).toBe(true);
    expect(target1).toBe(target2);
    expect(target1).not.toBe(target3);
  });
});
