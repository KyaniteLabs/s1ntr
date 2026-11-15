import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ORIGIN_SCHEMA = 'sinter.campaign-origin-receipt' as const;
const ROOT_SCHEMA = 'sinter.campaign-release-root' as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex');
}

export interface CampaignManifestBinding {
  readonly campaignRunId: string;
  readonly rootRunId: string;
  readonly manifestDigest: string;
  readonly releaseHead: string;
  readonly sourceFingerprint: string;
  readonly schemaDigest: string;
  readonly implementationDigest: string;
  readonly wave8ReleaseRootDigest: string;
  /** Present for finite campaigns admitted through W8C-05 funding authority. */
  readonly campaignFundingReservationDigest?: string;
  readonly campaignPlanDigest?: string;
  readonly campaignRouteFreezeDigest?: string;
}

export interface CampaignEvidenceReceipt {
  readonly receiptId: string;
  readonly kind: string;
  readonly resultDigest: string;
}

export interface CampaignOriginReceipt extends CampaignManifestBinding {
  readonly schema: typeof ORIGIN_SCHEMA;
  readonly schemaVersion: 1;
  readonly receiptId: string;
  readonly kind: 'campaign-origin';
  readonly keyId: string;
  readonly orderedReceiptDigests: readonly string[];
  readonly signatureBase64: string;
  readonly resultDigest: string;
}

export interface CampaignReleaseRoot extends CampaignManifestBinding {
  readonly schema: typeof ROOT_SCHEMA;
  readonly schemaVersion: 1;
  readonly receipts: readonly (CampaignEvidenceReceipt | CampaignOriginReceipt)[];
  readonly campaignRootDigest: string;
}

export interface CampaignAdmissionStore {
  claim(binding: CampaignManifestBinding): Promise<void>;
  /** Reopen the exact host-admitted campaign, including an already-terminal retry. */
  resume(binding: CampaignManifestBinding): Promise<CampaignOriginReceipt | undefined>;
  /** Atomically install the terminal effect, or return the exact effect already installed. */
  finalize(binding: CampaignManifestBinding, origin: CampaignOriginReceipt): Promise<CampaignOriginReceipt>;
}

export class InMemoryCampaignAdmissionStore implements CampaignAdmissionStore {
  readonly #states = new Map<string, {
    binding: CampaignManifestBinding;
    origin?: CampaignOriginReceipt;
  }>();
  claim(binding: CampaignManifestBinding): Promise<void> {
    const key = admissionKey(binding);
    if (this.#states.has(key)) return Promise.reject(new Error('Campaign has already been admitted'));
    this.#states.set(key, { binding: canonicalBinding(binding) });
    return Promise.resolve();
  }
  resume(binding: CampaignManifestBinding): Promise<CampaignOriginReceipt | undefined> {
    const state = this.#states.get(admissionKey(binding));
    if (!state) return Promise.reject(new Error('Campaign admission is missing'));
    assertSameBinding(state.binding, binding);
    return Promise.resolve(state.origin);
  }
  finalize(binding: CampaignManifestBinding, origin: CampaignOriginReceipt): Promise<CampaignOriginReceipt> {
    const state = this.#states.get(admissionKey(binding));
    if (!state) return Promise.reject(new Error('Campaign admission is missing'));
    assertSameBinding(state.binding, binding);
    if (!state.origin) state.origin = cloneOrigin(origin);
    return Promise.resolve(state.origin);
  }
}

/** Durable admission ledger. Binding and terminal origin are immutable, atomic filesystem effects. */
export class FileCampaignAdmissionStore implements CampaignAdmissionStore {
  constructor(private readonly root: string) {}
  private campaignPath(binding: CampaignManifestBinding): string {
    return path.join(this.root, digest({
      campaignRunId: binding.campaignRunId,
      manifestDigest: binding.manifestDigest,
    }));
  }
  private async readBinding(target: string): Promise<CampaignManifestBinding> {
    try {
      return JSON.parse(await readFile(path.join(target, 'binding.json'), 'utf8')) as CampaignManifestBinding;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Campaign admission is missing');
      throw new Error('Campaign admission binding is corrupt', { cause: error });
    }
  }
  private async readOrigin(target: string): Promise<CampaignOriginReceipt | undefined> {
    try {
      return JSON.parse(await readFile(path.join(target, 'origin.json'), 'utf8')) as CampaignOriginReceipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new Error('Campaign terminal origin is corrupt', { cause: error });
    }
  }
  async claim(binding: CampaignManifestBinding): Promise<void> {
    const target = this.campaignPath(binding);
    const staging = `${target}.${randomUUID()}.tmp`;
    await mkdir(this.root, { recursive: true });
    await mkdir(staging);
    try {
      await writeFile(path.join(staging, 'binding.json'), `${JSON.stringify(canonicalBinding(binding), null, 2)}\n`, {
        encoding: 'utf8', flag: 'wx',
      });
      await rename(staging, target);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        throw new Error('Campaign has already been admitted');
      }
      throw error;
    }
  }
  async resume(binding: CampaignManifestBinding): Promise<CampaignOriginReceipt | undefined> {
    const target = this.campaignPath(binding);
    assertSameBinding(await this.readBinding(target), binding);
    return this.readOrigin(target);
  }
  async finalize(binding: CampaignManifestBinding, origin: CampaignOriginReceipt): Promise<CampaignOriginReceipt> {
    const target = this.campaignPath(binding);
    assertSameBinding(await this.readBinding(target), binding);
    const existing = await this.readOrigin(target);
    if (existing) return existing;
    const temporary = path.join(target, `.origin.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(origin, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      try {
        await link(temporary, path.join(target, 'origin.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
    const installed = await this.readOrigin(target);
    if (!installed) throw new Error('Campaign terminal origin was not durably installed');
    return installed;
  }
}

declare const CAMPAIGN_CAPABILITY: unique symbol;
export interface CampaignOriginCapability { readonly [CAMPAIGN_CAPABILITY]: true }
interface CampaignCapabilityState {
  readonly binding: CampaignManifestBinding;
  readonly terminalOrigin?: CampaignOriginReceipt;
}

export interface CampaignOriginAuthority {
  admit(binding: CampaignManifestBinding): Promise<CampaignOriginCapability>;
  /** Host-only recovery of an admitted capability; never admits a new campaign. */
  resume(binding: CampaignManifestBinding): Promise<CampaignOriginCapability>;
  finalize(capability: CampaignOriginCapability, receipts: readonly CampaignEvidenceReceipt[]): Promise<CampaignOriginReceipt>;
}

function assertBinding(binding: CampaignManifestBinding): void {
  if (!binding.campaignRunId.trim() || !binding.rootRunId.trim()
    || !SHA256.test(binding.manifestDigest) || !SHA1.test(binding.releaseHead)
    || !SHA256.test(binding.sourceFingerprint) || !SHA256.test(binding.schemaDigest)
    || !SHA256.test(binding.implementationDigest) || !SHA256.test(binding.wave8ReleaseRootDigest)) {
    throw new Error('Campaign manifest binding is invalid');
  }
  const fundingFields = [binding.campaignFundingReservationDigest,
    binding.campaignPlanDigest, binding.campaignRouteFreezeDigest];
  if (fundingFields.some(value => value !== undefined)
    && fundingFields.some(value => value === undefined || !SHA256.test(value))) {
    throw new Error('Campaign funding origin binding is incomplete');
  }
}

const BINDING_FIELDS: readonly (keyof CampaignManifestBinding)[] = [
  'campaignRunId', 'rootRunId', 'manifestDigest', 'releaseHead', 'sourceFingerprint',
  'schemaDigest', 'implementationDigest', 'wave8ReleaseRootDigest',
  'campaignFundingReservationDigest', 'campaignPlanDigest', 'campaignRouteFreezeDigest',
];

function canonicalBinding(binding: CampaignManifestBinding): CampaignManifestBinding {
  return Object.freeze({
    campaignRunId: binding.campaignRunId,
    rootRunId: binding.rootRunId,
    manifestDigest: binding.manifestDigest,
    releaseHead: binding.releaseHead,
    sourceFingerprint: binding.sourceFingerprint,
    schemaDigest: binding.schemaDigest,
    implementationDigest: binding.implementationDigest,
    wave8ReleaseRootDigest: binding.wave8ReleaseRootDigest,
    ...(binding.campaignFundingReservationDigest ? {
      campaignFundingReservationDigest: binding.campaignFundingReservationDigest,
      campaignPlanDigest: binding.campaignPlanDigest,
      campaignRouteFreezeDigest: binding.campaignRouteFreezeDigest,
    } : {}),
  });
}

function admissionKey(binding: CampaignManifestBinding): string {
  return `${binding.campaignRunId}:${binding.manifestDigest}`;
}

function assertSameBinding(persisted: CampaignManifestBinding, requested: CampaignManifestBinding): void {
  assertBinding(persisted);
  if (BINDING_FIELDS.some(field => persisted[field] !== requested[field])) {
    throw new Error('Campaign admission binding does not match the immutable admitted origin');
  }
}

function cloneOrigin(origin: CampaignOriginReceipt): CampaignOriginReceipt {
  return Object.freeze({ ...origin, orderedReceiptDigests: Object.freeze([...origin.orderedReceiptDigests]) });
}

function assertTerminalOrigin(
  origin: CampaignOriginReceipt,
  binding: CampaignManifestBinding,
  expectedReceiptDigests: readonly string[] | undefined,
  keyId: string,
  publicKey: ReturnType<typeof createPublicKey>,
): void {
  assertSameBinding(origin, binding);
  if (origin.schema !== ORIGIN_SCHEMA || origin.schemaVersion !== 1
    || origin.kind !== 'campaign-origin' || origin.receiptId !== `campaign-origin:${binding.campaignRunId}`
    || origin.keyId !== keyId || !Array.isArray(origin.orderedReceiptDigests)
    || origin.orderedReceiptDigests.some(item => !SHA256.test(item))
    || new Set(origin.orderedReceiptDigests).size !== origin.orderedReceiptDigests.length
    || (expectedReceiptDigests && stable(origin.orderedReceiptDigests) !== stable(expectedReceiptDigests))
    || origin.resultDigest !== digest(originBody(origin))
    || !verify(null, Buffer.from(stable(originBody(origin))), publicKey,
      Buffer.from(origin.signatureBase64, 'base64'))) {
    throw new Error('Campaign terminal origin does not match the admitted evidence');
  }
}

function originBody(receipt: CampaignOriginReceipt): Omit<CampaignOriginReceipt, 'signatureBase64' | 'resultDigest'> {
  const { signatureBase64: _signature, resultDigest: _digest, ...body } = receipt;
  return body;
}

function rootBody(root: CampaignReleaseRoot): Omit<CampaignReleaseRoot, 'campaignRootDigest'> {
  const { campaignRootDigest: _digest, ...body } = root;
  return body;
}

export function createCampaignAuthority(options: {
  readonly keyId: string;
  readonly privateKeyPem: string;
  readonly admissionStore: CampaignAdmissionStore;
}): CampaignOriginAuthority {
  const privateKey = createPrivateKey(options.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const liveCapabilities = new WeakMap<object, CampaignCapabilityState>();
  return {
    async admit(binding: CampaignManifestBinding): Promise<CampaignOriginCapability> {
      assertBinding(binding);
      const admittedBinding = canonicalBinding(binding);
      await options.admissionStore.claim(admittedBinding);
      const capability = Object.freeze({}) as CampaignOriginCapability;
      liveCapabilities.set(capability, { binding: admittedBinding });
      return capability;
    },
    async resume(binding: CampaignManifestBinding): Promise<CampaignOriginCapability> {
      assertBinding(binding);
      const admittedBinding = canonicalBinding(binding);
      const terminalOrigin = await options.admissionStore.resume(admittedBinding);
      if (terminalOrigin) {
        assertTerminalOrigin(terminalOrigin, admittedBinding, undefined, options.keyId, publicKey);
      }
      const capability = Object.freeze({}) as CampaignOriginCapability;
      liveCapabilities.set(capability, {
        binding: admittedBinding,
        ...(terminalOrigin ? { terminalOrigin: cloneOrigin(terminalOrigin) } : {}),
      });
      return capability;
    },
    async finalize(capability: CampaignOriginCapability, receipts: readonly CampaignEvidenceReceipt[]): Promise<CampaignOriginReceipt> {
      const state = liveCapabilities.get(capability as object);
      if (!state) throw new Error('Campaign origin capability is invalid or consumed');
      const binding = state.binding;
      const orderedReceiptDigests = receipts.map(receipt => receipt.resultDigest);
      if (receipts.some(receipt => receipt.kind === 'campaign-origin')
        || new Set(receipts.map(receipt => receipt.receiptId)).size !== receipts.length
        || orderedReceiptDigests.some(item => !SHA256.test(item))
        || new Set(orderedReceiptDigests).size !== orderedReceiptDigests.length) {
        throw new Error('Campaign evidence membership is invalid');
      }
      const unsigned = {
        schema: ORIGIN_SCHEMA, schemaVersion: 1 as const,
        receiptId: `campaign-origin:${binding.campaignRunId}`, kind: 'campaign-origin' as const,
        ...binding, keyId: options.keyId, orderedReceiptDigests,
      };
      if (state.terminalOrigin) {
        assertTerminalOrigin(state.terminalOrigin, binding, orderedReceiptDigests, options.keyId, publicKey);
        liveCapabilities.delete(capability as object);
        return state.terminalOrigin;
      }
      const signatureBase64 = sign(null, Buffer.from(stable(unsigned)), privateKey).toString('base64');
      const receipt = { ...unsigned, signatureBase64, resultDigest: digest(unsigned) };
      const installed = await options.admissionStore.finalize(binding, receipt);
      assertTerminalOrigin(installed, binding, orderedReceiptDigests, options.keyId, publicKey);
      liveCapabilities.delete(capability as object);
      return cloneOrigin(installed);
    },
  };
}

export function createCampaignReleaseRoot(
  binding: CampaignManifestBinding,
  receipts: readonly CampaignEvidenceReceipt[],
  origin: CampaignOriginReceipt,
): CampaignReleaseRoot {
  const body = { schema: ROOT_SCHEMA, schemaVersion: 1 as const, ...binding, receipts: [...receipts, origin] };
  return { ...body, campaignRootDigest: digest(body) };
}

export function validateCampaignReleaseRoot(root: CampaignReleaseRoot, options: {
  readonly trustedKeys: ReadonlyMap<string, string>;
}): CampaignReleaseRoot {
  assertBinding(root);
  if (root.schema !== ROOT_SCHEMA || root.schemaVersion !== 1
    || root.campaignRootDigest !== digest(rootBody(root))) throw new Error('Campaign release root is invalid');
  const origins = root.receipts.filter(receipt => receipt.kind === 'campaign-origin') as CampaignOriginReceipt[];
  if (origins.length !== 1 || root.receipts.at(-1) !== origins[0]) throw new Error('Campaign root requires exactly one terminal origin');
  const origin = origins[0];
  const nonOrigin = root.receipts.slice(0, -1);
  const ids = root.receipts.map(receipt => receipt.receiptId);
  const digests = nonOrigin.map(receipt => receipt.resultDigest);
  if (new Set(ids).size !== ids.length || new Set(digests).size !== digests.length
    || stable(digests) !== stable(origin.orderedReceiptDigests)
    || digests.includes(origin.resultDigest)) throw new Error('Campaign receipt membership is invalid');
  const fields: (keyof CampaignManifestBinding)[] = [
    'campaignRunId', 'rootRunId', 'manifestDigest', 'releaseHead', 'sourceFingerprint',
    'schemaDigest', 'implementationDigest', 'wave8ReleaseRootDigest',
    'campaignFundingReservationDigest', 'campaignPlanDigest', 'campaignRouteFreezeDigest',
  ];
  if (fields.some(field => root[field] !== origin[field])) throw new Error('Campaign origin binding does not match root');
  if (origin.resultDigest !== digest(originBody(origin))) throw new Error('Campaign origin digest is invalid');
  const publicKey = options.trustedKeys.get(origin.keyId);
  if (!publicKey || !verify(null, Buffer.from(stable(originBody(origin))), createPublicKey(publicKey), Buffer.from(origin.signatureBase64, 'base64'))) {
    throw new Error('Campaign origin signature is untrusted');
  }
  return root;
}
