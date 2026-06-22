'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function Navigation() {
  const pathname = usePathname();

  return (
    <nav className="bg-gray-800 border-b border-gray-700">
      <div className="max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <Link href="/portfolio" className="text-xl font-bold text-white">
              포트폴리오 대시보드
            </Link>
          </div>
          
          <div className="flex items-center space-x-2">
            <div className="text-xs text-gray-400">
              기관 트레이딩 데스크
            </div>
            <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></div>
          </div>
        </div>
      </div>
    </nav>
  );
}
