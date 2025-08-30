/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
      },
    },
  },
  plugins: [],
  safelist: [
    // Ensure button colors are always available
    'bg-blue-500',
    'bg-blue-600',
    'hover:bg-blue-600',
    'bg-emerald-500',
    'bg-emerald-600', 
    'hover:bg-emerald-600',
    'bg-red-500',
    'bg-red-600',
    'hover:bg-red-600',
    'bg-gray-200',
    'text-gray-400',
    'focus:ring-blue-500',
    'focus:ring-emerald-500',
    'focus:ring-red-500',
  ]
}