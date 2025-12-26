export default function Home() {
  return (
    <div className="grid grid-rows-[20px_1fr_20px] items-center justify-items-center min-h-screen p-8 pb-20 gap-16 sm:p-20 font-[family-name:var(--font-geist-sans)]">
      <main className="flex flex-col gap-8 row-start-2 items-center sm:items-start">
        <div className="flex flex-col gap-4 items-center sm:items-start">
          <h1 className="text-4xl font-bold">Noosphere Agent</h1>
          <p className="text-sm text-center sm:text-left font-[family-name:var(--font-geist-mono)]">
            Decentralized compute agent for Noosphere protocol
          </p>
        </div>

        <div className="flex gap-4 items-center flex-col sm:flex-row">
          <div className="rounded-lg border border-solid border-transparent transition-colors flex items-center justify-center bg-foreground text-background gap-2 hover:bg-[#383838] dark:hover:bg-[#ccc] text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5">
            <a
              href="/dashboard"
              rel="noopener noreferrer"
            >
              View Dashboard
            </a>
          </div>
          <a
            className="rounded-lg border border-solid border-black/[.08] dark:border-white/[.145] transition-colors flex items-center justify-center hover:bg-[#f2f2f2] dark:hover:bg-[#1a1a1a] hover:border-transparent text-sm sm:text-base h-10 sm:h-12 px-4 sm:px-5 sm:min-w-44"
            href="https://github.com/hpp-io/noosphere-sdk"
            target="_blank"
            rel="noopener noreferrer"
          >
            View Documentation
          </a>
        </div>

        <div className="list-inside list-decimal text-sm text-center sm:text-left font-[family-name:var(--font-geist-mono)]">
          <div className="mb-2">
            <h2 className="font-semibold mb-2">Getting Started:</h2>
            <ol className="list-decimal list-inside space-y-1">
              <li>Copy <code className="bg-black/[.05] dark:bg-white/[.06] px-1 py-0.5 rounded font-semibold">.env.example</code> to <code className="bg-black/[.05] dark:bg-white/[.06] px-1 py-0.5 rounded font-semibold">.env</code></li>
              <li>Configure your keystore and RPC settings</li>
              <li>Run <code className="bg-black/[.05] dark:bg-white/[.06] px-1 py-0.5 rounded font-semibold">npm run agent</code> to start the agent</li>
            </ol>
          </div>
        </div>
      </main>

      <footer className="row-start-3 flex gap-6 flex-wrap items-center justify-center">
        <a
          className="flex items-center gap-2 hover:underline hover:underline-offset-4"
          href="https://hpp.io"
          target="_blank"
          rel="noopener noreferrer"
        >
          Built with Noosphere SDK
        </a>
      </footer>
    </div>
  );
}
