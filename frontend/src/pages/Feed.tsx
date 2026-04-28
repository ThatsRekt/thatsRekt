import { useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { fetchFeedPage, type FeedPost, type SortOption } from '../lib/queries'
import { PostCard } from '../components/PostCard'
import { EmptyState } from '../components/EmptyState'

const PAGE_SIZE = 25

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'newest', label: 'newest' },
  { value: 'oldest', label: 'oldest' },
]

export function Feed() {
  const [sort, setSort] = useState<SortOption>('newest')

  const {
    data,
    isLoading,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['feed', sort],
    queryFn: ({ pageParam }) => fetchFeedPage(pageParam, PAGE_SIZE),
    initialPageParam: 0,
    getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  })

  // Flatten + (optionally) reverse for "oldest" view. Mesh always returns
  // DESC; we reverse client-side and walk pages in the same order.
  const allPosts: FeedPost[] = data
    ? data.pages.flatMap((p) => p.items)
    : []
  const displayed = sort === 'oldest' ? allPosts.slice().reverse() : allPosts
  const totalCount = data?.pages[0]?.totalCount ?? 0

  return (
    <div>
      <SortBar current={sort} onChange={setSort} />
      <div className="mt-6">
        {isLoading ? (
          <p className="text-xs uppercase tracking-widest text-neutral-700">loading…</p>
        ) : error ? (
          <EmptyState
            title="couldn't load the feed."
            hint={`is the indexer running? ${(error as Error).message}`}
          />
        ) : displayed.length === 0 ? (
          <EmptyState
            title="no posts yet."
            hint="contract not deployed on any indexed chain, or no whitelister has posted an alert yet."
          />
        ) : (
          <FeedList
            posts={displayed}
            totalCount={totalCount}
            hasNextPage={!!hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={() => fetchNextPage()}
          />
        )}
      </div>
    </div>
  )
}

function SortBar({
  current,
  onChange,
}: {
  current: SortOption
  onChange: (s: SortOption) => void
}) {
  return (
    <div className="flex items-baseline gap-3 border-b border-black pb-3">
      <span className="text-[10px] uppercase tracking-widest text-neutral-700">sort:</span>
      <div className="flex gap-1">
        {SORT_OPTIONS.map((opt) => {
          const active = current === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
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
  )
}

interface FeedListProps {
  posts: FeedPost[]
  totalCount: number
  hasNextPage: boolean
  isFetchingNextPage: boolean
  onLoadMore: () => void
}

function FeedList({
  posts,
  totalCount,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: FeedListProps) {
  return (
    <div>
      {posts.map((post, i) => (
        <div key={post.id}>
          {i > 0 && <hr className="my-8 border-t-2 border-black" />}
          <PostCard post={post} />
        </div>
      ))}
      <div className="rekt-divider mt-8">* * *</div>
      {hasNextPage ? (
        <div className="flex flex-col items-center gap-2">
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
        <p className="text-center text-xs uppercase tracking-widest text-neutral-700">
          end of feed · {posts.length} post{posts.length === 1 ? '' : 's'}
        </p>
      )}
    </div>
  )
}
