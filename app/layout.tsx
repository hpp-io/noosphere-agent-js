import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Noosphere Agent',
  description: 'Decentralized compute agent for Noosphere protocol',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
