import { NextResponse } from 'next/server';
import { RegistryManager } from '@noosphere/registry';
import { loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Load configuration
    const config = loadConfig();

    // Load verifier registry
    const registry = new RegistryManager({
      autoSync: false,
      cacheTTL: 3600000,
    });
    await registry.load();

    // Get verifiers from registry
    const registryVerifiers = registry.listVerifiers();

    // Get verifiers from config (if defined)
    const configVerifiers = config.verifiers?.map(v => ({
      id: v.id,
      name: v.name,
      verifierAddress: v.address,
      requiresProof: v.requiresProof,
      proofService: v.proofService ? {
        imageName: v.proofService.image,
        port: v.proofService.port,
        command: v.proofService.command,
        env: v.proofService.env,
        requirements: v.proofService.requirements,
      } : undefined,
      verified: v.verified,
      description: v.description,
      payments: {},
    })) || [];

    // Merge verifiers
    const verifierMap = new Map();

    registryVerifiers.forEach(v => {
      verifierMap.set(v.id, {
        id: v.id,
        name: v.name,
        verifierAddress: v.verifierAddress,
        requiresProof: (v as any).requiresProof,
        proofService: (v as any).proofService,
        verified: (v as any).verified,
        description: (v as any).description,
        payments: v.payments,
      });
    });

    configVerifiers.forEach(v => {
      verifierMap.set(v.id, v);
    });

    const allVerifiers = Array.from(verifierMap.values());

    return NextResponse.json({
      verifiers: allVerifiers,
    });
  } catch (error) {
    console.error('Error loading verifiers:', error);
    return NextResponse.json(
      { error: 'Failed to load verifiers', details: (error as Error).message },
      { status: 500 }
    );
  }
}
