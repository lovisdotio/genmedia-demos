import type { Metadata } from 'next';
export const metadata: Metadata = {
  title: 'H3 · Worldline — FLUX 3 Action',
  description: 'One SO-101 arm state, four generated visual worlds: how the FLUX 3 Action policy responds.',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
