'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { formatUnits } from 'ethers';
import { apiFetch } from '../../lib/api';

type EventStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | 'expired';

interface HistoryEntry {
  requestId: string;
  subscriptionId: number;
  interval: number;
  blockNumber: number;
  timestamp: number;
  transactionHash: string;
  containerId: string;
  redundancy: number;
  feeAmount: string;
  feeToken: string;
  gasFee: string;
  feeEarned: string;
  isPenalty: boolean;
  status: EventStatus;
  errorMessage?: string;
  input: string;
  output: string;
}

interface HistoryResponse {
  agentAddress: string;
  paymentWallet: string;
  total: number;
  limit: number;
  offset: number;
  history: HistoryEntry[];
}

export default function HistoryPage() {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [limit] = useState(20);
  const [selectedEntry, setSelectedEntry] = useState<HistoryEntry | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const statusOptions = [
    { value: 'all', label: 'All' },
    { value: 'completed', label: 'Completed' },
    { value: 'pending', label: 'Pending' },
    { value: 'processing', label: 'Processing' },
    { value: 'failed', label: 'Failed' },
    { value: 'skipped', label: 'Skipped' },
    { value: 'expired', label: 'Expired' },
  ];

  useEffect(() => {
    async function fetchHistory() {
      try {
        setLoading(true);
        setError(null);

        let url = `/api/history?limit=${limit}&offset=${offset}`;
        if (statusFilter !== 'all') {
          url += `&status=${statusFilter}`;
        }

        const res = await apiFetch(url);
        if (!res.ok) {
          const errorData = await res.json();
          throw new Error(errorData.details || 'Failed to fetch history');
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
  }, [offset, limit, statusFilter]);

  // Reset offset when filter changes
  useEffect(() => {
    setOffset(0);
  }, [statusFilter]);

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const formatContainerId = (containerId: string) => {
    return containerId.substring(0, 12) + '...';
  };

  const formatAddress = (address: string) => {
    return address.substring(0, 6) + '...' + address.substring(address.length - 4);
  };

  const formatWei = (weiString: string): { value: string; unit: string } => {
    try {
      const wei = BigInt(weiString || '0');

      if (wei === 0n) {
        return { value: '0', unit: 'gwei' };
      }

      // Use gwei as default, only use wei for very small amounts
      const absWei = wei < 0n ? -wei : wei;

      if (absWei >= BigInt('100')) {
        // >= 100 wei (0.0000001 gwei) -> show in gwei with more precision for small values
        const gwei = formatUnits(weiString, 9);
        const gweiNum = Number(gwei);
        // Use more decimal places for smaller values
        const decimals = gweiNum < 0.0001 ? 8 : gweiNum < 0.01 ? 6 : 4;
        return { value: gweiNum.toFixed(decimals), unit: 'gwei' };
      } else {
        // < 100 wei -> show in wei
        return { value: wei.toString(), unit: 'wei' };
      }
    } catch (e) {
      return { value: '0', unit: 'gwei' };
    }
  };

  const formatBytes = (hexString: string) => {
    if (!hexString || hexString === '0x') return 'Empty';

    // Try to decode as UTF-8 text
    try {
      const hex = hexString.startsWith('0x') ? hexString.slice(2) : hexString;
      const bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

      // Check if it's printable text
      if (text && /^[\x20-\x7E\n\r\t]*$/.test(text)) {
        return text;
      }
    } catch (e) {
      // Not valid UTF-8, fall through to hex display
    }

    // Show as hex with length
    const length = (hexString.length - 2) / 2;
    return `${hexString.substring(0, 20)}... (${length} bytes)`;
  };

  if (loading && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600 dark:text-gray-400">Loading computing history...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-6 max-w-2xl">
          <h2 className="text-red-800 dark:text-red-400 font-semibold mb-2">Error Loading History</h2>
          <p className="text-red-700 dark:text-red-300 mb-4">{error}</p>
          <Link
            href="/"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            ← Back to Dashboard
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
              <Link
                href="/"
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline mb-2 inline-block"
              >
                ← Back to Dashboard
              </Link>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
                Computing History
              </h1>
              {data && (
                <div className="text-sm text-gray-600 dark:text-gray-400 mt-1 space-y-1">
                  <p>Agent EOA: <span className="font-mono">{formatAddress(data.agentAddress)}</span></p>
                  <p>Payment Wallet: <span className="font-mono">{formatAddress(data.paymentWallet)}</span></p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-4">
              {/* Prepare History Link */}
              <Link
                href="/prepare-history"
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-md transition-colors"
              >
                Prepare History
              </Link>
              {/* Status Filter */}
              <div>
                <label htmlFor="status-filter" className="block text-sm text-gray-600 dark:text-gray-400 mb-1">
                  Status
                </label>
                <select
                  id="status-filter"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="block w-40 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-blue-500 focus:border-blue-500"
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              {data && (
                <div className="text-right">
                  <p className="text-sm text-gray-600 dark:text-gray-400">Total</p>
                  <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">{data.total}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* History Table */}
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
          {data && data.history.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                  <thead className="bg-gray-50 dark:bg-gray-700">
                    <tr>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Time
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Subscription
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Status
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Container
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Fee Earned
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Gas Fee
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                        Net Profit
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
                    {data.history.map((entry) => {
                      const feeEarned = formatWei(entry.feeEarned || '0');
                      const gasFee = formatWei(entry.gasFee || '0');

                      // Calculate net profit in wei for accurate comparison
                      const netProfitWei = BigInt(entry.feeEarned || '0') - BigInt(entry.gasFee || '0');
                      const netProfit = formatWei(netProfitWei.toString());

                      return (
                        <tr
                          key={`${entry.requestId}-${entry.blockNumber}`}
                          onClick={() => setSelectedEntry(entry)}
                          className="hover:bg-blue-50 dark:hover:bg-blue-900/20 cursor-pointer transition-colors"
                        >
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm text-gray-900 dark:text-white">
                              {formatDate(entry.timestamp)}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              Block {entry.blockNumber}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className="px-3 py-1 text-sm font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 rounded-full">
                              #{entry.subscriptionId}
                            </span>
                            <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              Interval {entry.interval}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                              entry.status === 'completed' ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300' :
                              entry.status === 'pending' ? 'bg-yellow-100 dark:bg-yellow-900/30 text-yellow-800 dark:text-yellow-300' :
                              entry.status === 'processing' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300' :
                              entry.status === 'failed' ? 'bg-red-100 dark:bg-red-900/30 text-red-800 dark:text-red-300' :
                              entry.status === 'skipped' ? 'bg-gray-100 dark:bg-gray-900/30 text-gray-800 dark:text-gray-300' :
                              entry.status === 'expired' ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-800 dark:text-orange-300' :
                              'bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-300'
                            }`}>
                              {entry.status}
                            </span>
                          </td>
                          <td className="px-6 py-4">
                            <div className="text-sm font-mono text-gray-900 dark:text-white">
                              {formatContainerId(entry.containerId)}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm font-medium">
                              {entry.isPenalty ? (
                                <span className="text-red-600 dark:text-red-400">
                                  -{feeEarned.value} {feeEarned.unit}
                                </span>
                              ) : (
                                <span className="text-green-600 dark:text-green-400">
                                  +{feeEarned.value} {feeEarned.unit}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className="text-sm text-gray-900 dark:text-white">
                              {gasFee.value} {gasFee.unit}
                            </div>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap">
                            <div className={`text-sm font-semibold ${
                              netProfitWei >= 0n
                                ? 'text-green-600 dark:text-green-400'
                                : 'text-red-600 dark:text-red-400'
                            }`}>
                              {netProfitWei >= 0n ? '+' : ''}{netProfit.value} {netProfit.unit}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              <div className="bg-gray-50 dark:bg-gray-700 px-6 py-4 flex items-center justify-between border-t border-gray-200 dark:border-gray-600">
                <div className="text-sm text-gray-700 dark:text-gray-300">
                  Showing <span className="font-medium">{offset + 1}</span> to{' '}
                  <span className="font-medium">{Math.min(offset + limit, data.total)}</span> of{' '}
                  <span className="font-medium">{data.total}</span> results
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setOffset(Math.max(0, offset - limit))}
                    disabled={offset === 0}
                    className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Previous
                  </button>
                  <button
                    onClick={() => setOffset(offset + limit)}
                    disabled={offset + limit >= data.total}
                    className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="text-center py-12">
              <svg
                className="mx-auto h-12 w-12 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
              <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-white">No computing history</h3>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                This agent hasn't processed any requests yet.
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Detail Modal */}
      {selectedEntry && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50" onClick={() => setSelectedEntry(null)}>
          <div className="bg-white dark:bg-gray-800 rounded-lg max-w-4xl w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex justify-between items-center">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                Request Details
              </h2>
              <button
                onClick={() => setSelectedEntry(null)}
                className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Content */}
            <div className="px-6 py-4 space-y-6">
              {/* Summary */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">Subscription ID</label>
                  <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">#{selectedEntry.subscriptionId}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">Interval</label>
                  <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">{selectedEntry.interval}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">Timestamp</label>
                  <p className="mt-1 text-sm text-gray-900 dark:text-white">{formatDate(selectedEntry.timestamp)}</p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-500 dark:text-gray-400">Block Number</label>
                  <p className="mt-1 text-sm text-gray-900 dark:text-white">{selectedEntry.blockNumber}</p>
                </div>
              </div>

              {/* Financial Details */}
              <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-4">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Financial Details</h3>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400">Fee Earned</label>
                    <p className={`mt-1 text-lg font-semibold ${
                      selectedEntry.isPenalty ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'
                    }`}>
                      {selectedEntry.isPenalty ? '-' : '+'}{formatWei(selectedEntry.feeEarned || '0').value} {formatWei(selectedEntry.feeEarned || '0').unit}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{selectedEntry.isPenalty ? 'Penalty' : 'Earned'}</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400">Gas Fee</label>
                    <p className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">
                      {formatWei(selectedEntry.gasFee || '0').value} {formatWei(selectedEntry.gasFee || '0').unit}
                    </p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400">Net Profit</label>
                    {(() => {
                      const netProfitWei = BigInt(selectedEntry.feeEarned || '0') - BigInt(selectedEntry.gasFee || '0');
                      const netProfit = formatWei(netProfitWei.toString());
                      return (
                        <p className={`mt-1 text-lg font-semibold ${
                          netProfitWei >= 0n
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}>
                          {netProfitWei >= 0n ? '+' : ''}{netProfit.value} {netProfit.unit}
                        </p>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* IDs */}
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Request ID</label>
                <p className="font-mono text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded break-all text-gray-900 dark:text-white">
                  {selectedEntry.requestId}
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Container ID</label>
                <p className="font-mono text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded break-all text-gray-900 dark:text-white">
                  {selectedEntry.containerId}
                </p>
              </div>

              {/* Input */}
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Input</label>
                <div className="bg-gray-100 dark:bg-gray-900 p-4 rounded">
                  <pre className="font-mono text-xs whitespace-pre-wrap break-all text-gray-900 dark:text-white">
                    {formatBytes(selectedEntry.input)}
                  </pre>
                </div>
              </div>

              {/* Output */}
              <div>
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Output</label>
                <div className="bg-gray-100 dark:bg-gray-900 p-4 rounded">
                  <pre className="font-mono text-xs whitespace-pre-wrap break-all text-gray-900 dark:text-white">
                    {formatBytes(selectedEntry.output)}
                  </pre>
                </div>
              </div>

              {/* Error Message (for failed/skipped/expired) */}
              {selectedEntry.errorMessage && (
                <div>
                  <label className="block text-sm font-medium text-red-500 dark:text-red-400 mb-2">Error Message</label>
                  <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 rounded">
                    <pre className="font-mono text-xs whitespace-pre-wrap break-all text-red-700 dark:text-red-300">
                      {selectedEntry.errorMessage}
                    </pre>
                  </div>
                </div>
              )}

              {/* Transaction */}
              <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                <label className="block text-sm font-medium text-gray-500 dark:text-gray-400 mb-2">Transaction Hash</label>
                {selectedEntry.transactionHash ? (
                  <p className="font-mono text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded break-all text-gray-900 dark:text-white">
                    {selectedEntry.transactionHash}
                  </p>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-gray-400 italic">No transaction sent</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
