'use strict';

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./client/index.html', './client/src/**/*.{js,html}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['DM Sans', 'system-ui', 'sans-serif']
      },
      colors: {
        surface: {
          DEFAULT: '#0f1419',
          card: '#161b22',
          border: '#21262d'
        }
      }
    }
  },
  plugins: []
};
