'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiFetch } from '../../lib/api';

interface PrepareTransaction {
  id: number;
  txHash: string;
  blockNumber: number;
  subscriptionId: number;
  interval: number;
  gasUsed: string;
  gasPrice: string;
  gasCost: string;
  gasCostEth: string;
  status: 'success' | 'failed';
  errorMessage?: string;
  createdAt: string;
}

interface PrepareStats {
  totalTxs: number;
  totalGasCost: string;
  totalGasCostEth: string;
  successCount: number;
  failedCount: number;
}

interface PrepareHistoryResponse {
  stats: PrepareStats;
  pagination: {
    total: number;
    limit: number;
    offset: number;
    hasMore: boolean;
  };
  transactions: PrepareTransaction[];
}

export default function PrepareHistoryPage() {
  const [data, setData] = useState<PrepareHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(20);
  const [subscriptionFilter, setSubscriptionFilter] = useState<string>('');

  useEffect(() => {
    async function fetchHistory() {
      try {
        setLoading(true);
        setError(null);

        let url = `/api/prepare-history?limit=${limit}&offset=${offset}`;
        if (subscriptionFilter) {
          url += `&subscriptionId=${subscriptionFilter}`;
        }

        const res = await apiFetch(url);
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.details || 'Failed to fetch prepare history');
        }

        const historyData = await res.json();
        setData(historyData);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setLoading(false);
      }
    }

    fetchHistory();
  }, [offset, limit, subscriptionFilter]);

  // Reset offset when filter changes
  useEffect(() => {
    setOffset(0);
  }, [subscriptionFilter]);

  const formatDate = (dateString: string) => {
    return new Date(dateString + 'Z').toLocaleString();
  };

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading prepare history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-2xl">
          <h2 className="text-red-800 dark:text-red-400 font-semibold mb-2">Error Loading Prepare History</h2>
          <p className="text-red-700 dark:text-red-300 mb-4">{error}</p>
          <Link href="/" className="text-blue-600 hover:text-blue-800 dark:text-blue-400">
            &larr; Back to Dashboard
          </Link>
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
            <div>
              <Link href="/" className="text-blue-600 hover:text-blue-800 dark:text-blue-400 text-sm mb-2 inline-block">
                &larr; Back to Dashboard
              </Link>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
                Prepare Transaction History
              </h1>
              <p className="text-gray-500 dark:text-gray-400 mt-1">
                Scheduler&apos;s prepareNextInterval transactions (gas costs)
              </p>
            </div>
            <nav className="flex gap-4">
              <Link
                href="/history"
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors"
              >
                Compute History
              </Link>
            </nav>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Stats */}
        {data?.stats && (
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Prepare Txs</p>
              <p className="text-2xl font-bold text-gray-900 dark:text-white">{data.stats.totalTxs}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Gas Cost</p>
              <p className="text-2xl font-bold text-orange-600 dark:text-orange-400">{parseFloat(data.stats.totalGasCostEth).toFixed(8)} ETH</p>
            </div>
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
              <p className="text-sm text-gray-500 dark:text-gray-400">Successful</p>
              <p className="text-2xl font-bold text-green-600 dark:text-green-400">{data.stats.successCount || 0}</p>
            </div>
            <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
              <p className="text-sm text-gray-500 dark:text-gray-400">Failed</p>
              <p className="text-2xl font-bold text-red-600 dark:text-red-400">{data.stats.failedCount || 0}</p>
            </div>
          </div>
        )}

        {/* Filter */}
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4 mb-6">
          <div className="flex items-center gap-4">
            <label className="text-sm text-gray-600 dark:text-gray-400">Filter by Subscription:</label>
            <input
              type="number"
              value={subscriptionFilter}
              onChange={(e) => setSubscriptionFilter(e.target.value)}
              placeholder="Subscription ID"
              className="px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm w-40"
            />
            {subscriptionFilter && (
              <button
                onClick={() => setSubscriptionFilter('')}
                className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Table */}
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
          {data && data.transactions.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Tx Hash
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Sub
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Int
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Block
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Gas Cost
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Status
                      </th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                        Time
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                    {data.transactions.map((tx) => (
                      <tr key={tx.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/50">
                        <td className="px-4 py-3">
                          <span className="font-mono text-xs text-gray-900 dark:text-white break-all">
                            {tx.txHash}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-900 dark:text-white">
                          #{tx.subscriptionId}
                        </td>
                        <td className="px-4 py-3 text-gray-900 dark:text-white">
                          {tx.interval}
                        </td>
                        <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                          {tx.blockNumber}
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-orange-600 dark:text-orange-400 font-medium text-sm">
                            {parseFloat(tx.gasCostEth).toFixed(10)} ETH
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`px-2 py-1 text-xs rounded-full ${
                              tx.status === 'success'
                                ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300'
                                : 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300'
                            }`}
                          >
                            {tx.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">
                          {formatDate(tx.createdAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Showing {offset + 1} - {Math.min(offset + limit, data.pagination.total)} of {data.pagination.total}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOffset(Math.max(0, offset - limit))}
                    disabled={offset === 0}
                    className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setOffset(offset + limit)}
                    disabled={!data.pagination.hasMore}
                    className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12">
              <p className="text-gray-500 dark:text-gray-400">No prepare transactions found</p>
              <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
                Prepare transactions will appear here when the scheduler prepares intervals for scheduled subscriptions.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
