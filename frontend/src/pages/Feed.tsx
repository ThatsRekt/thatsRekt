import { useCallback, useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { fetchFeedPage, type FeedPost, type SortOption } from '../lib/queries'
import { selectArchive, type ArchivePost } from '../lib/archive'
import { PostCard } from '../components/PostCard'
import { ChainSelector } from '../components/ChainSelector'
import { ArchiveDivider } from '../components/ArchiveDivider'
import { EmptyState } from '../components/EmptyState'
import { InfoPopover } from '../components/InfoPopover'
import { RefreshButton } from '../components/RefreshButton'
import { FeedTLDR } from '../components/FeedTLDR'
import { useChainFilter } from '../hooks/useChainFilter'
import { useArchiveToggle } from '../hooks/useArchiveToggle'
import { useIndexerStatus } from '../hooks/useIndexerStatus'

const PAGE_SIZE = 20
/** Archive entries (static JSON) revealed per "load more" click. Same
 *  cadence as the live feed so the two feel consistent. */
const ARCHIVE_PAGE_SIZE = 20

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'newest' },
  { value: 'oldest', label: 'oldest' },
]

export function Feed() {
  const [sort, setSort] = useState<SortOption>('newest')
  const { filter: chainFilter, setFilter: setChainFilter } = useChainFilter()
  const { showArchive, setShowArchive } = useArchiveToggle()

  // Pass an array (single-element when scoped) — Mesh accepts a list.
  // queryKey includes the filter so TanStack discriminates per scope and
  // refetches cleanly on switch.
  const chainSlugs = chainFilter ? [chainFilter] : undefined

  const queryClient = useQueryClient()

  const {
    data,
    isLoading,
    isFetching: isFeedFetching,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['feed', sort, chainFilter ?? 'all'],
    queryFn: ({ pageParam }) => fetchFeedPage(pageParam, PAGE_SIZE, chainSlugs),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
    // Manual refresh only — clicking Feed in the nav re-mounts this
    // page; without this we'd refetch on every nav back to `/`. The
    // refresh button (FilterBar) explicitly invalidates `['feed']`
    // when the user wants fresh data.
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })

  const indexerStatus = useIndexerStatus()

  // Manual refresh: invalidate every variant of the feed query (so all
  // sort × chainFilter combos held in cache get re-fetched on next view)
  // and re-run the indexer-status query immediately. We don't await here
  // — the feed/indexer fetching states drive the spinner separately.
  const handleRefresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['feed'] })
    void indexerStatus.refetch()
  }, [queryClient, indexerStatus])

  // Combined "something is in flight" state for the refresh button.
  const isRefreshing = isFeedFetching || indexerStatus.isFetching

  // Flatten + (optionally) reverse for "oldest" view. Mesh always returns
  // DESC; we reverse client-side and walk pages in the same order.
  const allPosts: FeedPost[] = data
    ? data.pages.flatMap((p) => p.items)
    : []
  const livePosts = sort === 'oldest' ? allPosts.slice().reverse() : allPosts
  const totalLiveCount = data?.pages[0]?.totalCount ?? 0

  // Archive selection is in-memory + frozen at module load — useMemo
  // keeps the filter/sort cheap on re-renders triggered by network state.
  const archivePosts: readonly ArchivePost[] = useMemo(
    () => (showArchive ? selectArchive({ chainSlug: chainFilter, sort }) : []),
    [showArchive, chainFilter, sort],
  )

  return (
    <div>
      <FeedTLDR />
      <FilterBar
        sort={sort}
        onSortChange={setSort}
        chainFilter={chainFilter}
        onChainChange={setChainFilter}
        showArchive={showArchive}
        onShowArchiveChange={setShowArchive}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing}
      />
      <div className="mt-6">
        <FeedBody
          isLoading={isLoading}
          error={error as Error | null}
          livePosts={livePosts}
          totalLiveCount={totalLiveCount}
          hasNextPage={!!hasNextPage}
          isFetchingNextPage={isFetchingNextPage}
          onLoadMore={() => fetchNextPage()}
          archivePosts={archivePosts}
          showArchive={showArchive}
          // When sort=oldest, render the archive ABOVE the live section.
          // Archives are by definition older than any on-chain post, so
          // this preserves global chronology — "oldest first" reads as
          // The DAO 2016 → today, top to bottom.
          archiveAbove={sort === 'oldest'}
        />
      </div>
    </div>
  )
}

interface FeedBodyProps {
  isLoading: boolean
  error: Error | null
  livePosts: FeedPost[]
  totalLiveCount: number
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
  archivePosts: readonly ArchivePost[]
  showArchive: boolean
  archiveAbove: boolean
}

function FeedBody({
  isLoading,
  error,
  livePosts,
  totalLiveCount,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  archivePosts,
  showArchive,
  archiveAbove,
}: FeedBodyProps) {
  if (isLoading) {
    return (
      <p className="text-xs uppercase tracking-widest text-neutral-700">loading…</p>
    )
  }

  const liveEmpty = livePosts.length === 0
  const archiveEmpty = archivePosts.length === 0

  // GraphQL error: surface it inline at the top, but DON'T hide the
  // archive section. The archive is static frontend data and works
  // even when the indexer is unreachable — letting users still browse
  // historical incidents during an outage.
  const errorBanner = error ? (
    <div className="border-2 border-red-600 bg-red-50 px-4 py-3 mb-6 text-xs uppercase tracking-widest text-red-700">
      <p className="font-black">couldn't load the live feed.</p>
      <p className="mt-1 normal-case tracking-normal text-neutral-800">
        Is the indexer running? <span className="font-mono">{error.message}</span>
      </p>
    </div>
  ) : null

  // Both sections empty AND no error — single-block empty state with
  // hint that depends on whether archive is hidden.
  if (!error && liveEmpty && archiveEmpty) {
    return (
      <EmptyState
        title="no attacks reported yet."
        hint={
          showArchive
            ? 'no on-chain attacks have been indexed, and no archive entries match the current chain filter.'
            : 'no on-chain attacks have been indexed. Toggle "show archive" above to see pre-platform attacks.'
        }
      />
    )
  }

  const renderLive = !liveEmpty && (
    <LiveSection
      posts={livePosts}
      totalCount={totalLiveCount}
      hasNextPage={hasNextPage}
      isFetchingNextPage={isFetchingNextPage}
      onLoadMore={onLoadMore}
    />
  )
  const renderArchive = !archiveEmpty && <ArchiveSection posts={archivePosts} />
  const renderDivider = !liveEmpty && !archiveEmpty && <ArchiveDivider />

  return (
    <div>
      {errorBanner}

      {/* Launch-day affordance: live empty + archive on + archive
          non-empty → tell the user the archive is what they're seeing.
          Independent of section order — just a top-of-page hint. */}
      {!error && liveEmpty && showArchive && !archiveEmpty && (
        <p className="mb-6 text-xs uppercase tracking-widest text-neutral-700">
          no on-chain attacks yet · showing pre-platform archive
        </p>
      )}

      {archiveAbove ? (
        <>
          {renderArchive}
          {renderDivider}
          {renderLive}
        </>
      ) : (
        <>
          {renderLive}
          {renderDivider}
          {renderArchive}
        </>
      )}
    </div>
  )
}

function FilterBar({
  sort,
  onSortChange,
  chainFilter,
  onChainChange,
  showArchive,
  onShowArchiveChange,
  onRefresh,
  isRefreshing,
}: {
  sort: SortOption
  onSortChange: (s: SortOption) => void
  chainFilter: string | null
  onChainChange: (next: string | null) => void
  showArchive: boolean
  onShowArchiveChange: (next: boolean) => void
  onRefresh: () => void
  isRefreshing: boolean
}) {
  return (
    <div className="border-b border-black pb-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="flex items-baseline gap-3">
          <span className="text-[10px] uppercase tracking-widest text-neutral-700">sort:</span>
          <div className="flex gap-1">
            {SORT_OPTIONS.map((opt) => {
              const active = sort === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onSortChange(opt.value)}
                  className={
                    'px-2 py-0.5 text-xs uppercase tracking-widest border ' +
                    (active
                      ? 'border-black bg-black text-[#f5f4ee]'
                      : 'border-transparent text-neutral-700 hover:border-black hover:text-black')
                  }
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Right side of the primary row: chain selector then a small
            icon-only refresh button at the far right. Archive toggle is
            a content-mode switch and gets its own line below. */}
        <div className="flex items-center gap-x-2">
          <ChainSelector value={chainFilter} onChange={onChainChange} />
          <RefreshButton onRefresh={onRefresh} isFetching={isRefreshing} />
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <ArchiveToggle value={showArchive} onChange={onShowArchiveChange} />
      </div>
    </div>
  )
}

function ArchiveToggle({
  value,
  onChange,
}: {
  value: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-baseline gap-1">
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-pressed={value}
        className={
          'px-2 py-0.5 text-xs uppercase tracking-widest border ' +
          (value
            ? 'border-black bg-black text-[#f5f4ee]'
            : 'border-black text-neutral-700 hover:bg-black hover:text-[#f5f4ee]')
        }
      >
        {value ? '✓ ' : ''}show archive
      </button>
      <InfoPopover title="archive attacks" ariaLabel="what is the archive?">
        Pre-platform attacks compiled by the community. Archive entries
        are off-chain context — they're not on the registry and can't
        be confirmed or disconfirmed. They appear below the live feed
        in their own section.
      </InfoPopover>
    </div>
  )
}

function LiveSection({
  posts,
  totalCount,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  posts: FeedPost[]
  totalCount: number
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}) {
  return (
    <div>
      {posts.map((post, i) => (
        <div key={post.id}>
          {i > 0 && <hr className="my-8 border-t-2 border-black" />}
          <PostCard item={{ kind: 'live', post }} />
        </div>
      ))}
      {hasNextPage ? (
        <div className="mt-8 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
            className="px-3 py-1.5 text-xs uppercase tracking-widest font-black border-2 border-black hover:bg-black hover:text-[#f5f4ee] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isFetchingNextPage ? 'loading…' : 'load more'}
          </button>
          <p className="text-[10px] uppercase tracking-widest text-neutral-500">
            showing {posts.length} of {totalCount}
          </p>
        </div>
      ) : (
        <p className="mt-8 text-center text-xs uppercase tracking-widest text-neutral-700">
          end of live feed · {posts.length} attack{posts.length === 1 ? '' : 's'}
        </p>
      )}
    </div>
  )
}

function ArchiveSection({ posts }: { posts: readonly ArchivePost[] }) {
  // Subtle gray-cream tint differentiates the archive zone from live posts
  // at a glance — the page bg is #f5f4ee (warm cream), this is a slightly
  // darker / cooler tone. Keeps the brutalist aesthetic but signals
  // "you've crossed into the archive subspace" without needing to read
  // the divider text.
  //
  // Pagination is purely client-side here — the archive is static JSON
  // that's already in memory after `selectArchive(...)`. We just cap how
  // many entries hit the DOM at once so a user with archive toggled on
  // doesn't render 40+ post cards in a single paint. Reset the visible
  // window when the underlying `posts` array identity changes (e.g. the
  // user flipped the chain filter or sort).
  const [visibleCount, setVisibleCount] = useState(ARCHIVE_PAGE_SIZE)
  useEffect(() => {
    setVisibleCount(ARCHIVE_PAGE_SIZE)
  }, [posts])

  const visiblePosts = posts.slice(0, visibleCount)
  const hasMore = visibleCount < posts.length

  return (
    <section className="bg-neutral-300/40 -mx-4 sm:-mx-6 px-4 sm:px-6 py-8 border-y-2 border-neutral-500/60">
      {visiblePosts.map((post, i) => (
        <div key={post.id}>
          {i > 0 && <hr className="my-8 border-t-2 border-neutral-400/60" />}
          <PostCard item={{ kind: 'archive', post }} />
        </div>
      ))}
      {hasMore ? (
        <div className="mt-8 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={() =>
              setVisibleCount((n) => Math.min(n + ARCHIVE_PAGE_SIZE, posts.length))
            }
            className="px-3 py-1.5 text-xs uppercase tracking-widest font-black border-2 border-black hover:bg-black hover:text-[#f5f4ee] transition-colors"
          >
            load more
          </button>
          <p className="text-[10px] uppercase tracking-widest text-neutral-600">
            showing {visiblePosts.length} of {posts.length}
          </p>
        </div>
      ) : (
        <p className="mt-8 text-center text-xs uppercase tracking-widest text-neutral-600">
          end of archive · {posts.length} entr{posts.length === 1 ? 'y' : 'ies'}
        </p>
      )}
    </section>
  )
}
