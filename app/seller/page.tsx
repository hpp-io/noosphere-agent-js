'use client';

/**
 * x402 Seller dashboard tab (M5-c).
 * Layout follows the approved mockup (design 03 §8): KPI tiles → wallets →
 * services table → recent paid jobs feed. Styling matches the existing
 * dashboard pages (Tailwind, light/dark).
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '../../lib/api';

interface Summary {
  calls24h: number;
  callsTotal: number;
  settled24h: number;
  failed24h: number;
  earnings30d: string;
  earningsPrev30d: string;
  settleSuccessRate24h: number | null;
  activeServices: { total: number; direct: number; onchain: number };
}

interface Wallets {
  payTo: { address: string; usdce: string | null };
  gas: { address: string; eth: string | null } | null;
}

interface ServiceRow {
  name: string;
  containerId: string;
  settlement: 'direct' | 'onchain';
  network: string;
  price: string;
  schemes: string[];
  description?: string;
  calls24h: number;
  callsTotal: number;
  earnings30d: string;
}

interface JobRow {
  job_id: string;
  service: string;
  settlement: string;
  scheme: string | null;
  payer: string | null;
  amount: string | null;
  settle_tx: string | null;
  status: string;
  created_at: string;
}

const usdce = (atomic?: string | null) =>
  atomic == null ? '—' : (Number(atomic) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 });

const short = (a?: string | null, n = 6) => (a ? `${a.slice(0, n + 2)}…${a.slice(-4)}` : '—');

const statusPill = (status: string) => {
  const map: Record<string, string> = {
    settled: 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300',
    completed: 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300',
    running: 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300',
    pending: 'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300',
    failed: 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300',
  };
  return map[status] ?? map.pending;
};

export default function SellerDashboard() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [wallets, setWallets] = useState<Wallets | null>(null);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [s, w, sv, j] = await Promise.all([
          apiFetch('/api/seller/summary'),
          apiFetch('/api/seller/wallets'),
          apiFetch('/api/seller/services'),
          apiFetch('/api/seller/jobs?limit=25'),
        ]);
        if (!s.ok) throw new Error(`seller API unavailable (${s.status}) — is x402Seller.enabled?`);
        if (!alive) return;
        setSummary(await s.json());
        setWallets(w.ok ? await w.json() : null);
        setServices(sv.ok ? (await sv.json()).services : []);
        setJobs(j.ok ? (await j.json()).jobs : []);
        setError(null);
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    }
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const delta =
    summary && Number(summary.earningsPrev30d) > 0
      ? ((Number(summary.earnings30d) - Number(summary.earningsPrev30d)) / Number(summary.earningsPrev30d)) * 100
      : null;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="bg-white dark:bg-gray-800 shadow">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">x402 Seller</h1>
          <nav className="flex gap-4">
            <a href="/" className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors">
              Dashboard
            </a>
            <a href="/history" className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors">
              Computing History
            </a>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {loading && <p className="text-gray-500 dark:text-gray-400">Loading…</p>}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 p-4 rounded-lg mb-8">
            {error}
          </div>
        )}

        {summary && (
          <>
            {/* KPI tiles */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-5">
                <p className="text-sm text-gray-500 dark:text-gray-400">💰 Earnings · 30d</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                  {usdce(summary.earnings30d)} <span className="text-sm font-medium text-gray-400">USDC.e</span>
                </p>
                {delta !== null && (
                  <p className={`text-xs font-semibold mt-1 ${delta >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {delta >= 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}% vs prev 30d
                  </p>
                )}
              </div>
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-5">
                <p className="text-sm text-gray-500 dark:text-gray-400">⚡ Paid calls · 24h</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{summary.calls24h}</p>
                <p className="text-xs text-gray-400 mt-1">{summary.callsTotal} all-time</p>
              </div>
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-5">
                <p className="text-sm text-gray-500 dark:text-gray-400">✅ Settle success · 24h</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">
                  {summary.settleSuccessRate24h === null ? '—' : `${(summary.settleSuccessRate24h * 100).toFixed(1)}%`}
                </p>
                <p className="text-xs text-gray-400 mt-1">{summary.failed24h} failed / {summary.settled24h + summary.failed24h}</p>
              </div>
              <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-5">
                <p className="text-sm text-gray-500 dark:text-gray-400">🛒 Services</p>
                <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{summary.activeServices.total}</p>
                <p className="text-xs text-gray-400 mt-1">
                  {summary.activeServices.direct} direct · {summary.activeServices.onchain} on-chain
                </p>
              </div>
            </div>

            {/* Wallets */}
            {wallets && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-5">
                  <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">↓ Receiving (payTo)</p>
                  <p className="text-xl font-bold text-gray-900 dark:text-white mt-1">
                    {usdce(wallets.payTo.usdce)} <span className="text-sm font-medium text-gray-400">USDC.e</span>
                  </p>
                  <p className="font-mono text-xs text-gray-500 dark:text-gray-400 mt-1 break-all">{wallets.payTo.address}</p>
                  <p className="text-xs text-gray-400 mt-1">Direct settlements land here — buyer → payTo, no custody.</p>
                </div>
                {wallets.gas && (
                  <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-5">
                    <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">⛽ Agent gas (EOA)</p>
                    <p className="text-xl font-bold text-gray-900 dark:text-white mt-1">
                      {wallets.gas.eth ? Number(wallets.gas.eth).toFixed(5) : '—'} <span className="text-sm font-medium text-gray-400">ETH</span>
                    </p>
                    <p className="font-mono text-xs text-gray-500 dark:text-gray-400 mt-1 break-all">{wallets.gas.address}</p>
                    <p className="text-xs text-gray-400 mt-1">Funds on-chain delivery gas (subscription rail).</p>
                  </div>
                )}
              </div>
            )}

            {/* Services table */}
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg mb-8 overflow-x-auto">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white px-5 pt-5">Services</h2>
              <table className="min-w-full text-sm mt-3">
                <thead>
                  <tr className="text-left text-xs uppercase text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-2">Service</th>
                    <th className="px-5 py-2">Settlement</th>
                    <th className="px-5 py-2">Price</th>
                    <th className="px-5 py-2">Schemes</th>
                    <th className="px-5 py-2 text-right">Calls 24h</th>
                    <th className="px-5 py-2 text-right">Earnings 30d</th>
                  </tr>
                </thead>
                <tbody>
                  {services.map((s) => (
                    <tr key={s.name} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="px-5 py-3">
                        <p className="font-semibold text-gray-900 dark:text-white">{s.name}</p>
                        <p className="font-mono text-xs text-gray-400">{short(s.containerId, 10)}</p>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${
                          s.settlement === 'onchain'
                            ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-300'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                        }`}>
                          {s.settlement === 'onchain' ? '⛓ on-chain' : 'direct'}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-gray-900 dark:text-white">
                        {usdce(s.price)} <span className="text-xs text-gray-400">USDC.e/call</span>
                      </td>
                      <td className="px-5 py-3">
                        {s.schemes.map((sc) => (
                          <span key={sc} className="inline-flex px-2 py-0.5 mr-1 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-xs font-mono">
                            {sc}
                          </span>
                        ))}
                      </td>
                      <td className="px-5 py-3 text-right text-gray-900 dark:text-white">{s.calls24h}</td>
                      <td className="px-5 py-3 text-right font-semibold text-gray-900 dark:text-white">{usdce(s.earnings30d)}</td>
                    </tr>
                  ))}
                  {services.length === 0 && (
                    <tr><td colSpan={6} className="px-5 py-6 text-center text-gray-400">No services configured</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Jobs feed */}
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-x-auto">
              <h2 className="text-lg font-semibold text-gray-900 dark:text-white px-5 pt-5">Recent paid jobs</h2>
              <table className="min-w-full text-sm mt-3">
                <thead>
                  <tr className="text-left text-xs uppercase text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="px-5 py-2">Time</th>
                    <th className="px-5 py-2">Service</th>
                    <th className="px-5 py-2">Payer</th>
                    <th className="px-5 py-2">Scheme</th>
                    <th className="px-5 py-2 text-right">Amount</th>
                    <th className="px-5 py-2">Settle tx</th>
                    <th className="px-5 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((j) => (
                    <tr key={j.job_id} className="border-b border-gray-100 dark:border-gray-700/50">
                      <td className="px-5 py-3 text-gray-500 dark:text-gray-400 whitespace-nowrap">
                        {new Date(j.created_at + 'Z').toLocaleTimeString()}
                      </td>
                      <td className="px-5 py-3 font-semibold text-gray-900 dark:text-white">{j.service}</td>
                      <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{short(j.payer)}</td>
                      <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">{j.scheme ?? '—'}</td>
                      <td className="px-5 py-3 text-right text-gray-900 dark:text-white">{usdce(j.amount)}</td>
                      <td className="px-5 py-3 font-mono text-xs text-gray-500 dark:text-gray-400" title={j.settle_tx ?? undefined}>
                        {short(j.settle_tx, 8)}
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${statusPill(j.status)}`}>
                          {j.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                  {jobs.length === 0 && (
                    <tr><td colSpan={7} className="px-5 py-6 text-center text-gray-400">No paid jobs yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
