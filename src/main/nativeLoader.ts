import * as path from 'path';
import * as fs from 'fs';

/**
 * Load a native module (.node file) from multiple possible locations
 * Works in both development and packaged environments
 */
export function loadNativeModule(moduleName: string): any {
  const possiblePaths = [
    // Development: relative to dist/main/
    path.join(__dirname, `../../build/Release/${moduleName}.node`),
    // Packaged: in Resources directory
    path.join(process.resourcesPath || '', `build/Release/${moduleName}.node`),
    // Packaged: unpacked from asar
    path.join(process.resourcesPath || '', `app.asar.unpacked/build/Release/${moduleName}.node`),
    // Packaged: in app directory
    path.join(__dirname, `../../../build/Release/${moduleName}.node`)
  ];

  for (const modulePath of possiblePaths) {
    try {
      if (fs.existsSync(modulePath)) {
        const module = require(modulePath);
        console.log(`✓ Native module '${moduleName}' loaded from: ${modulePath}`);
        return module;
      }
    } catch (error) {
      // Try next path
    }
  }

  throw new Error(`Failed to load native module '${moduleName}'. Tried paths: ${possiblePaths.join(', ')}`);
}
