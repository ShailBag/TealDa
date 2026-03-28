'use strict';

const path = require('path');
const { defineConfig } = require('vite');

module.exports = defineConfig({
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false
  },
  base: './'
});
