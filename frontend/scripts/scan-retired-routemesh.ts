import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const RETIRED_HOST = ['lb', 'routeme', 'sh'].join('.')
const RETIRED_ENDPOINT_PATTERN = new RegExp(
  `https://${RETIRED_HOST.replaceAll('.', '\\.')}/rpc/\\d+/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`,
  'gi',
)
const TEXT_FILE_SUFFIXES = ['.css', '.html', '.js', '.map', '.ts', '.tsx'] as const

const textFilesAt = async (path: string): Promise<string[]> => {
  const metadata = await stat(path)
  if (metadata.isFile()) {
    return TEXT_FILE_SUFFIXES.some((suffix) => path.endsWith(suffix)) ? [path] : []
  }

  const entries = await readdir(path, { withFileTypes: true })
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = join(path, entry.name)
      if (entry.isDirectory()) return textFilesAt(entryPath)
      return entry.isFile() && TEXT_FILE_SUFFIXES.some((suffix) => entryPath.endsWith(suffix))
        ? [entryPath]
        : []
    }),
  )
  return nestedFiles.flat()
}

export const scanText = (text: string): number => {
  RETIRED_ENDPOINT_PATTERN.lastIndex = 0
  let count = 0
  while (RETIRED_ENDPOINT_PATTERN.exec(text) !== null) count += 1
  return count
}

export const formatScanReport = (
  countsByFilename: Readonly<Record<string, number>>,
): string => {
  const rows = Object.entries(countsByFilename).map(
    ([filename, count]) => `${filename}: ${count}`,
  )
  const occurrences = Object.values(countsByFilename).reduce(
    (total, count) => total + count,
    0,
  )
  return [...rows, `files=${rows.length} occurrences=${occurrences}`].join('\n')
}

export const scanPaths = async ({
  paths,
  cwd,
}: {
  readonly paths: readonly string[]
  readonly cwd: string
}): Promise<Readonly<Record<string, number>>> => {
  const files = (await Promise.all(paths.map(textFilesAt))).flat().sort()
  const entries = await Promise.all(
    files.map(async (file) => [
      relative(cwd, file),
      scanText(await readFile(file, 'utf8')),
    ] as const),
  )
  return Object.fromEntries(entries)
}

const main = async (): Promise<void> => {
  const paths = process.argv.slice(2)
  if (paths.length === 0) {
    throw new Error('Expected at least one source or build artifact path')
  }

  const countsByFilename = await scanPaths({ paths, cwd: process.cwd() })
  const report = formatScanReport(countsByFilename)
  console.log(report)

  if (report.endsWith('occurrences=0')) return
  process.exitCode = 1
}

if (import.meta.main) await main()
