'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '../lib/api';

interface AgentStatus {
  agentAddress: string;
  balance: string;
  paymentWallets: Array<{
    address: string;
    balance: string;
  }>;
  rpcUrl: string;
  routerAddress?: string;
  coordinatorAddress?: string;
}

interface Container {
  id: string;
  name: string;
  imageName: string;
  verified?: boolean;
  tags?: string[];
  description?: string;
  requirements?: {
    memory?: string;
    cpu?: number;
    gpu?: boolean;
  };
  payments?: {
    basePrice: string;
    token: string;
    per: string;
  };
}

interface Verifier {
  id: string;
  name: string;
  verifierAddress?: string;
  verified?: boolean;
  description?: string;
  requiresProof?: boolean;
  proofService?: {
    imageName?: string;
    port?: string;
  };
}

interface ContainersResponse {
  stats: {
    totalContainers: number;
    activeContainers: number;
    totalVerifiers: number;
    activeVerifiers: number;
  };
  containers: Container[];
}

interface VerifiersResponse {
  verifiers: Verifier[];
}

interface SchedulerStatus {
  enabled: boolean;
  cronIntervalMs: number;
  syncPeriodMs: number;
  scheduler: {
    tracking: number;
    active: number;
    pendingTxs: number;
  };
  events: {
    total: number;
    completed: number;
    failed: number;
    skipped: number;
    expired: number;
    pending: number;
    processing: number;
  };
  // Legacy fields for backward compatibility
  stats: {
    totalSubscriptions: number;
    activeSubscriptions: number;
    committedIntervals: number;
    pendingTransactions: number;
  };
  subscriptions: any[];
  lastRun: string;
  nextRun: string;
}

export default function Dashboard() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [containers, setContainers] = useState<ContainersResponse | null>(null);
  const [verifiers, setVerifiers] = useState<VerifiersResponse | null>(null);
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        // Fetch agent status
        const agentRes = await apiFetch('/api/agent/status');
        if (!agentRes.ok) {
          const errorData = await agentRes.json();
          throw new Error(errorData.details || 'Failed to fetch agent status');
        }
        const agentData = await agentRes.json();
        setAgentStatus(agentData);

        // Fetch containers
        const containersRes = await apiFetch('/api/containers');
        if (containersRes.ok) {
          const containersData = await containersRes.json();
          setContainers(containersData);
        }

        // Fetch verifiers
        const verifiersRes = await apiFetch('/api/verifiers');
        if (verifiersRes.ok) {
          const verifiersData = await verifiersRes.json();
          setVerifiers(verifiersData);
        }

        // Fetch scheduler status
        const schedulerRes = await apiFetch('/api/scheduler');
        if (schedulerRes.ok) {
          const schedulerData = await schedulerRes.json();
          setScheduler(schedulerData);
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    // Refresh every 30 seconds
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading agent data...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-2xl">
          <h2 className="text-red-800 dark:text-red-400 font-semibold mb-2">Error Loading Agent</h2>
          <p className="text-red-700 dark:text-red-300 mb-4">{error}</p>
          <p className="text-sm text-red-600 dark:text-red-400">
            Make sure your .env file is configured correctly and the keystore exists.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              Noosphere Agent Dashboard
            </h1>
            <nav className="flex gap-4">
              <a
                href="/history"
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-md transition-colors"
              >
                Computing History
              </a>
              <a
                href="/prepare-history"
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors"
              >
                Prepare History
              </a>
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Scheduler Status Section */}
        {scheduler && (
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white flex items-center">
              <span className="mr-2">🕐</span> Scheduler (Scheduled Subscriptions)
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-blue-50 dark:bg-blue-900/20 p-4 rounded">
                <p className="text-sm text-gray-600 dark:text-gray-400">Tracking</p>
                <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                  {scheduler.scheduler?.tracking ?? scheduler.stats.totalSubscriptions}
                </p>
              </div>
              <div className="bg-green-50 dark:bg-green-900/20 p-4 rounded">
                <p className="text-sm text-gray-600 dark:text-gray-400">Active</p>
                <p className="text-2xl font-bold text-green-600 dark:text-green-400">
                  {scheduler.scheduler?.active ?? scheduler.stats.activeSubscriptions}
                </p>
              </div>
              <div className="bg-orange-50 dark:bg-orange-900/20 p-4 rounded">
                <p className="text-sm text-gray-600 dark:text-gray-400">Pending Txs</p>
                <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">
                  {scheduler.scheduler?.pendingTxs ?? scheduler.stats.pendingTransactions}
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm mb-6">
              <div>
                <p className="text-gray-500 dark:text-gray-400">Commitment Interval</p>
                <p className="font-medium text-gray-900 dark:text-white">
                  {scheduler.cronIntervalMs / 1000}s
                </p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-gray-400">Sync Period</p>
                <p className="font-medium text-gray-900 dark:text-white">
                  {scheduler.syncPeriodMs / 1000}s
                </p>
              </div>
              <div>
                <p className="text-gray-500 dark:text-gray-400">Status</p>
                <p className="font-medium text-green-600 dark:text-green-400">
                  {scheduler.enabled ? '● Running' : '○ Stopped'}
                </p>
              </div>
            </div>

            {/* Events Section */}
            <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
              <h3 className="text-lg font-semibold mb-3 text-gray-900 dark:text-white flex items-center">
                <span className="mr-2">📊</span> Events (All Requests)
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Total</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-white">
                    {scheduler.events?.total ?? 0}
                  </p>
                </div>
                <div className="bg-green-50 dark:bg-green-900/20 p-3 rounded text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Completed</p>
                  <p className="text-xl font-bold text-green-600 dark:text-green-400">
                    {scheduler.events?.completed ?? 0}
                  </p>
                </div>
                <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Failed</p>
                  <p className="text-xl font-bold text-red-600 dark:text-red-400">
                    {scheduler.events?.failed ?? 0}
                  </p>
                </div>
                <div className="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Skipped</p>
                  <p className="text-xl font-bold text-yellow-600 dark:text-yellow-400">
                    {scheduler.events?.skipped ?? 0}
                  </p>
                </div>
                <div className="bg-gray-100 dark:bg-gray-600/50 p-3 rounded text-center">
                  <p className="text-xs text-gray-500 dark:text-gray-400">Expired</p>
                  <p className="text-xl font-bold text-gray-600 dark:text-gray-300">
                    {scheduler.events?.expired ?? 0}
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Agent Status Section */}
        {agentStatus && (
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4 text-gray-900 dark:text-white">
              Agent Wallet
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Wallet Address</p>
                <p className="font-mono text-sm mt-1 text-gray-900 dark:text-white break-all">
                  {agentStatus.agentAddress}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Balance</p>
                <p className="text-lg font-semibold mt-1 text-gray-900 dark:text-white">
                  {agentStatus.balance} gwei
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Router Address</p>
                <p className="font-mono text-sm mt-1 text-gray-900 dark:text-white break-all">
                  {agentStatus.routerAddress || 'Not configured'}
                </p>
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">Coordinator Address</p>
                <p className="font-mono text-sm mt-1 text-gray-900 dark:text-white break-all">
                  {agentStatus.coordinatorAddress || 'Not configured'}
                </p>
              </div>
              <div className="col-span-2">
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-2">Payment Wallets</p>
                {agentStatus.paymentWallets && agentStatus.paymentWallets.length > 0 ? (
                  <div className="space-y-2">
                    {agentStatus.paymentWallets.map((wallet, index) => (
                      <div key={index} className="bg-gray-50 dark:bg-gray-700 rounded p-2">
                        <p className="font-mono text-xs text-gray-900 dark:text-white break-all">
                          {wallet.address}
                        </p>
                        <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Balance: {wallet.balance} gwei
                        </p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400">No payment wallets configured</p>
                )}
              </div>
              <div>
                <p className="text-sm text-gray-500 dark:text-gray-400">RPC URL</p>
                <p className="text-sm mt-1 text-gray-900 dark:text-white truncate">
                  {agentStatus.rpcUrl}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Containers Section */}
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 mb-8">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Available Containers
            </h2>
            {containers && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {containers.stats.activeContainers} / {containers.stats.totalContainers} active
              </span>
            )}
          </div>
          {containers && containers.containers.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead>
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Image
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Tags
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Requirements
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                  {containers.containers.map((container) => (
                    <tr key={container.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                      <td className="px-4 py-3">
                        <div>
                          <p className="font-medium text-gray-900 dark:text-white">
                            {container.name}
                          </p>
                          <p className="font-mono text-xs text-gray-400 dark:text-gray-500" title={container.id}>
                            {container.id.slice(0, 10)}...{container.id.slice(-6)}
                          </p>
                          {container.description && (
                            <p className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-xs">
                              {container.description}
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-mono text-sm text-gray-900 dark:text-white">
                          {container.imageName}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        {container.tags && container.tags.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {container.tags.slice(0, 3).map((tag) => (
                              <span
                                key={tag}
                                className="px-2 py-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 rounded"
                              >
                                {tag}
                              </span>
                            ))}
                            {container.tags.length > 3 && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                +{container.tags.length - 3}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {container.requirements ? (
                          <div className="text-sm text-gray-900 dark:text-white">
                            {container.requirements.memory && (
                              <div>Mem: {container.requirements.memory}</div>
                            )}
                            {container.requirements.cpu && (
                              <div>CPU: {container.requirements.cpu}</div>
                            )}
                            {container.requirements.gpu && (
                              <div className="text-purple-600 dark:text-purple-400">GPU Required</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 dark:text-gray-500">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                          <span className="text-sm text-gray-900 dark:text-white">Active</span>
                          {container.verified && (
                            <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 px-2 py-1 rounded">
                              Verified
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No containers available
            </p>
          )}
        </div>

        {/* Verifiers Section */}
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
          <div className="flex justify-between items-center mb-4">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Available Verifiers
            </h2>
            {verifiers && (
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {verifiers.verifiers.length} verifiers
              </span>
            )}
          </div>
          {verifiers && verifiers.verifiers.length > 0 ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {verifiers.verifiers.map((verifier) => (
                <div
                  key={verifier.id}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-medium text-gray-900 dark:text-white">
                        {verifier.name}
                      </h3>
                      {verifier.description && (
                        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                          {verifier.description}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                      {verifier.verified && (
                        <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 px-2 py-1 rounded">
                          Verified
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Contract: </span>
                      <span className="font-mono text-gray-900 dark:text-white break-all">
                        {verifier.verifierAddress || '-'}
                      </span>
                    </div>
                    {verifier.proofService?.imageName && (
                      <div>
                        <span className="text-gray-500 dark:text-gray-400">Image: </span>
                        <span className="font-mono text-gray-900 dark:text-white break-all">
                          {verifier.proofService.imageName}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No verifiers available
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
