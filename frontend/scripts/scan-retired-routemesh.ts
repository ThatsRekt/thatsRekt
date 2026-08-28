import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROUTEMESH_HOST = ['lb', 'routeme', 'sh'].join('.')
const ROUTEMESH_ENDPOINT_PATTERN = new RegExp(
  `https://${ROUTEMESH_HOST.replaceAll('.', '\\.')}/rpc/\\d+/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}`,
  'g',
)
const RETIRED_ENDPOINT_FINGERPRINTS: Readonly<Record<string, true>> = {
  'eacc85c18860cb08cb8cae9a1ddcc3ea2da4888b9aae4eed7a8c09a093a8b84e': true,
  '9d7ee12ff96793a1fd2031e7b91f16122c98f3264db0b18fd06c15a3f68c6ccb': true,
  '7e4221c2640fabfd70dbfee07a870daf0cc00d2b9301d5e49f76c13af153bede': true,
  '84a19971cf0e201f52fc3c3f9ef88dab509d4680b1ce76758cfd8f6908cd59b6': true,
  '094d96deaca03396d540527d53bb2441a3a0d0396397de1f4a1ffb991e8720cd': true,
  '222498e0761911a8d588233b2ac2c998204d51b4bf52968ed117ef05fb4b057e': true,
}
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

export const scanText = (
  text: string,
  retiredEndpointFingerprints = RETIRED_ENDPOINT_FINGERPRINTS,
): number => {
  ROUTEMESH_ENDPOINT_PATTERN.lastIndex = 0
  let count = 0
  for (
    let match = ROUTEMESH_ENDPOINT_PATTERN.exec(text);
    match !== null;
    match = ROUTEMESH_ENDPOINT_PATTERN.exec(text)
  ) {
    const fingerprint = createHash('sha256').update(match[0]).digest('hex')
    if (retiredEndpointFingerprints[fingerprint] === true) count += 1
  }
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
