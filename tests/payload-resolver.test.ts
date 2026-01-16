import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { PayloadUtils, InputType } from '@noosphere/agent-core';
import {
  PayloadResolver,
  DataUriProvider,
} from '../src/services/payload-resolver';

// Helper to check if hex string contains a substring when decoded
function hexContains(hex: string, substring: string): boolean {
  if (!hex.startsWith('0x')) return hex.includes(substring);
  const decoded = ethers.toUtf8String(hex);
  return decoded.includes(substring);
}

describe('PayloadResolver', () => {
  let resolver: PayloadResolver;

  beforeEach(() => {
    resolver = new PayloadResolver({
      uploadThreshold: 100, // Low threshold for testing
      defaultStorage: 'data', // Use data URI for tests (no external deps)
    });
  });

  describe('Input Type Detection', () => {
    it('should detect raw data input', () => {
      const input = 'Hello, World!';
      expect(resolver.detectInputType(input)).toBe(InputType.RAW_DATA);
    });

    it('should detect IPFS URI input', () => {
      const input = 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
      expect(resolver.detectInputType(input)).toBe(InputType.URI_STRING);
    });

    it('should detect HTTPS URI input', () => {
      const input = 'https://api.example.com/data/123';
      expect(resolver.detectInputType(input)).toBe(InputType.URI_STRING);
    });

    it('should detect data URI input', () => {
      const input = 'data:application/json;base64,eyJ0ZXN0IjoidmFsdWUifQ==';
      expect(resolver.detectInputType(input)).toBe(InputType.URI_STRING);
    });

    it('should detect Arweave URI input', () => {
      const input = 'ar://bNbA3TEQVL60xlgCcqdz4ZPH';
      expect(resolver.detectInputType(input)).toBe(InputType.URI_STRING);
    });

    it('should detect PayloadData object', () => {
      const input = {
        contentHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        uri: ethers.hexlify(ethers.toUtf8Bytes('ipfs://QmTest')), // Hex-encoded URI
      };
      expect(resolver.detectInputType(input)).toBe(InputType.PAYLOAD_DATA);
    });

    it('should detect typed raw input', () => {
      const input = { type: 'raw' as const, data: 'test data' };
      expect(resolver.detectInputType(input)).toBe(InputType.RAW_DATA);
    });

    it('should detect typed URI input', () => {
      const input = { type: 'uri' as const, uri: 'https://example.com/data' };
      expect(resolver.detectInputType(input)).toBe(InputType.URI_STRING);
    });

    it('should detect typed PayloadData input', () => {
      const input = {
        type: 'payload' as const,
        payload: {
          contentHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          uri: '0x', // Empty hex bytes
        },
      };
      expect(resolver.detectInputType(input)).toBe(InputType.PAYLOAD_DATA);
    });
  });

  describe('Input Resolution', () => {
    it('should resolve raw data input', async () => {
      const content = 'Hello, World!';
      const result = await resolver.resolveInput(content);

      expect(result.content).toBe(content);
      expect(result.payload.contentHash).toBe(
        ethers.keccak256(ethers.toUtf8Bytes(content))
      );
      // URI is hex-encoded data: URI for inline content
      expect(result.payload.uri).toMatch(/^0x/);
      expect(hexContains(result.payload.uri, 'data:')).toBe(true);
    });

    it('should resolve data URI input', async () => {
      const originalContent = '{"test":"value"}';
      const base64 = Buffer.from(originalContent).toString('base64');
      const dataUri = `data:application/json;base64,${base64}`;

      const result = await resolver.resolveInput(dataUri);

      expect(result.content).toBe(originalContent);
      // URI is hex-encoded
      expect(hexContains(result.payload.uri, dataUri)).toBe(true);
    });

    it('should resolve typed raw input', async () => {
      const content = 'test data';
      const input = { type: 'raw' as const, data: content };

      const result = await resolver.resolveInput(input);

      expect(result.content).toBe(content);
      // URI is hex-encoded data: URI for inline content
      expect(result.payload.uri).toMatch(/^0x/);
      expect(hexContains(result.payload.uri, 'data:')).toBe(true);
    });

    it('should handle inline PayloadData (with data: URI)', async () => {
      const originalContent = 'original content';
      const payload = PayloadUtils.fromInlineData(originalContent);
      const result = await resolver.resolveInput(payload);

      // The payload contains a hex-encoded data: URI with the content base64-encoded
      // The resolver should decode the hex URI and extract the content
      expect(result.payload).toEqual(payload);
      // Content should be recovered from the data: URI
      expect(result.content).toBe(originalContent);
    });
  });

  describe('Output Encoding', () => {
    it('should encode small output inline', async () => {
      const content = 'small output';
      const result = await resolver.encodeOutput(content);

      // URI is hex-encoded data: URI for inline content
      expect(result.uri).toMatch(/^0x/);
      expect(hexContains(result.uri, 'data:')).toBe(true);
      expect(result.contentHash).toBe(
        ethers.keccak256(ethers.toUtf8Bytes(content))
      );
    });

    it('should encode large output with data URI', async () => {
      // Content larger than threshold (100 bytes)
      const content = 'x'.repeat(200);
      const result = await resolver.encodeOutput(content);

      // URI is hex-encoded and contains data:
      expect(result.uri).toMatch(/^0x/);
      expect(hexContains(result.uri, 'data:')).toBe(true);
      expect(result.contentHash).toBe(
        ethers.keccak256(ethers.toUtf8Bytes(content))
      );
    });

    it('should force upload when requested', async () => {
      const content = 'small';
      const result = await resolver.encodeOutput(content, { forceUpload: true });

      // URI is hex-encoded and contains data:
      expect(result.uri).toMatch(/^0x/);
      expect(hexContains(result.uri, 'data:')).toBe(true);
    });
  });

  describe('Empty PayloadData', () => {
    it('should create empty payload', () => {
      const empty = resolver.createEmpty();

      expect(empty.contentHash).toBe(ethers.ZeroHash);
      // Empty URI is '0x' (empty bytes in hex)
      expect(empty.uri).toBe('0x');
    });
  });

  describe('Content Verification', () => {
    it('should verify matching content', () => {
      const content = 'test content';
      const payload = PayloadUtils.fromInlineData(content);

      expect(resolver.verifyContent(payload, content)).toBe(true);
    });

    it('should reject tampered content', () => {
      const original = 'original content';
      const tampered = 'tampered content';
      const payload = PayloadUtils.fromInlineData(original);

      expect(resolver.verifyContent(payload, tampered)).toBe(false);
    });
  });

  describe('Serialization', () => {
    it('should serialize PayloadData', () => {
      const payload = {
        contentHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        uri: 'ipfs://QmTest',
      };

      const serialized = resolver.serializePayload(payload);
      const parsed = JSON.parse(serialized);

      expect(parsed.contentHash).toBe(payload.contentHash);
      expect(parsed.uri).toBe(payload.uri);
    });

    it('should deserialize PayloadData', () => {
      const payload = {
        contentHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        uri: 'ipfs://QmTest',
      };

      const serialized = JSON.stringify(payload);
      const deserialized = resolver.deserializePayload(serialized);

      expect(deserialized).toEqual(payload);
    });

    it('should handle legacy string format in deserialization', () => {
      const legacyContent = 'legacy raw content';
      const deserialized = resolver.deserializePayload(legacyContent);

      expect(deserialized.contentHash).toBe(
        ethers.keccak256(ethers.toUtf8Bytes(legacyContent))
      );
      // URI is hex-encoded data: URI
      expect(deserialized.uri).toMatch(/^0x/);
      expect(hexContains(deserialized.uri, 'data:')).toBe(true);
    });
  });
});

describe('DataUriProvider', () => {
  let provider: DataUriProvider;

  beforeEach(() => {
    provider = new DataUriProvider();
  });

  it('should upload content as data URI', async () => {
    const content = '{"test":"value"}';
    const uri = await provider.upload(content);

    expect(uri).toContain('data:application/json;base64,');
  });

  it('should download data URI content', async () => {
    const content = '{"test":"value"}';
    const base64 = Buffer.from(content).toString('base64');
    const dataUri = `data:application/json;base64,${base64}`;

    const downloaded = await provider.download(dataUri);

    expect(downloaded).toBe(content);
  });

  it('should round-trip content', async () => {
    const original = '{"data": [1, 2, 3], "nested": {"key": "value"}}';
    const uri = await provider.upload(original);
    const downloaded = await provider.download(uri);

    expect(downloaded).toBe(original);
  });
});
