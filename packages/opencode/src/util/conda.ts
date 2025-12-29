import { $ } from "bun"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Log } from "./log"

const log = Log.create({ service: "conda" })

/**
 * Detects a conda environment by name and returns the Python interpreter path
 * @param name The conda environment name
 * @returns The full path to the Python interpreter, or null if not found
 */
export async function detectCondaEnv(name: string): Promise<string | null> {
  // Try conda info --envs --json first
  try {
    const result = await $`conda info --envs --json`.quiet().nothrow().text()
    const info = JSON.parse(result)
    const envs = info.envs as string[]

    for (const envPath of envs) {
      // Match environment name at the end of the path
      if (envPath.endsWith(`/envs/${name}`) || envPath.endsWith(`\\envs\\${name}`) || envPath.endsWith(`/${name}`)) {
        const pythonPath = getPythonPath(envPath)
        if (await fileExists(pythonPath)) {
          log.info("found conda env via conda info", { name, pythonPath })
          return pythonPath
        }
      }
    }
  } catch (e) {
    log.debug("conda info failed, trying fallback paths", { error: String(e) })
  }

  // Fallback: check common conda installation paths
  const home = os.homedir()
  const candidates = [
    path.join(home, "miniconda3", "envs", name),
    path.join(home, "anaconda3", "envs", name),
    path.join(home, "miniforge3", "envs", name),
    path.join(home, ".conda", "envs", name),
    // Linux/macOS system paths
    path.join("/opt", "conda", "envs", name),
    path.join("/opt", "miniconda3", "envs", name),
    path.join("/opt", "anaconda3", "envs", name),
  ]

  for (const envPath of candidates) {
    const pythonPath = getPythonPath(envPath)
    if (await fileExists(pythonPath)) {
      log.info("found conda env via fallback path", { name, pythonPath })
      return pythonPath
    }
  }

  log.warn("conda env not found", { name })
  return null
}

/**
 * Gets the Python interpreter path for a given conda environment path
 */
function getPythonPath(envPath: string): string {
  return process.platform === "win32"
    ? path.join(envPath, "Scripts", "python.exe")
    : path.join(envPath, "bin", "python")
}

/**
 * Checks if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
