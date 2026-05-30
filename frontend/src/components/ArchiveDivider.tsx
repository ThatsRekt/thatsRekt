/**
 * Visual cleave between the live onchain feed and the archive
 * section. Rendered only when both sections have visible items.
 */
export function ArchiveDivider() {
  return (
    <div className="my-12 flex items-center gap-4">
      <span className="h-px flex-1 bg-black" />
      <span className="text-[10px] font-black uppercase tracking-[0.3em] text-neutral-700 whitespace-nowrap">
        archive · pre-platform
      </span>
      <span className="h-px flex-1 bg-black" />
    </div>
  )
}
