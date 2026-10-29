import { Debouncer } from "@tanstack/pacer";
import { useInfiniteQuery } from "@tanstack/react-query";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@nonanium/ui";
import type { ChatPickerMediaGroup } from "@tensamin/shared/data";
import { useStorage } from "@tensamin/storage/context";
import { ArrowLeft, Loader2, Search } from "lucide-react";
import MediaSaveButton from "./mediaSaveButton";
import { getUngroupedMedia } from "./mediaGroups";
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  startTransition,
} from "react";

const klipyApiKey =
  "KzyghnvdlaHjJuDycVx6rLIEu5eaacPyFERieoI7L8UWLt2rnJloL45UL5MVc9IG";
const klipyBaseUrl = "https://api.klipy.com/api/v1";
const pageSize = 24;
const minColumnWidth = 200;

function getColumnCount(width: number, itemCount: number) {
  return Math.max(
    1,
    Math.min(itemCount || 1, Math.floor(width / minColumnWidth)),
  );
}

type KlipyKind = "gif" | "meme";

type KlipyItem = {
  id: number | string;
  title?: string;
  file?: Record<
    string,
    | Record<
        string,
        | {
            url?: string;
            width?: number;
            height?: number;
          }
        | undefined
      >
    | undefined
  >;
  blur_preview?: string;
};

type PickerMedia = {
  key: React.Key;
  url: string;
  alt: string;
  width?: number;
  height?: number;
};

function distributeByHeight<T>(
  items: T[],
  columnCount: number,
  getAspectRatio: (item: T) => number,
) {
  const columns = Array.from({ length: columnCount }, () => [] as T[]);
  const columnHeights = Array.from({ length: columnCount }, () => 0);

  for (const item of items) {
    const shortestColumnIndex = columnHeights.indexOf(
      Math.min(...columnHeights),
    );

    columns[shortestColumnIndex].push(item);
    columnHeights[shortestColumnIndex] += getAspectRatio(item);
  }

  return columns;
}

function getKlipyPath(kind: KlipyKind) {
  const resource = kind === "gif" ? "gifs" : "static-memes";

  return `${resource}/search`;
}

async function fetchKlipyPage({
  kind,
  page,
  search,
}: {
  kind: KlipyKind;
  page: number;
  search: string;
}): Promise<{
  items: KlipyItem[];
  currentPage: number;
  hasNext: boolean;
}> {
  const params = new URLSearchParams({
    page: String(page),
    per_page: String(pageSize),
    content_filter: "medium",
  });

  if (search !== "") {
    params.set("q", search);
  }

  if (kind === "gif") {
    params.set("format_filter", "gif,webp");
  }

  const response = await fetch(
    `${klipyBaseUrl}/${klipyApiKey}/${getKlipyPath(kind)}?${params}`,
  );

  if (!response.ok) {
    throw new Error(`Klipy request failed with status ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: {
      data?: KlipyItem[];
      current_page?: number;
      has_next?: boolean;
    };
  };
  const data = body.data;

  return {
    items: data?.data ?? [],
    currentPage: data?.current_page ?? page,
    hasNext: data?.has_next ?? false,
  };
}

function getFormat(item: KlipyItem, size: string, format: string) {
  return item.file?.[size]?.[format];
}

function pickDisplayMedia(kind: KlipyKind, item: KlipyItem) {
  if (kind === "gif") {
    return (
      getFormat(item, "sm", "webp") ??
      getFormat(item, "md", "webp") ??
      getFormat(item, "sm", "gif") ??
      getFormat(item, "md", "gif") ??
      getFormat(item, "hd", "webp") ??
      getFormat(item, "hd", "gif")
    );
  }

  return (
    getFormat(item, "sm", "webp") ??
    getFormat(item, "md", "webp") ??
    getFormat(item, "sm", "png") ??
    getFormat(item, "md", "png") ??
    getFormat(item, "hd", "webp") ??
    getFormat(item, "hd", "png")
  );
}

function pickSelectionUrl(kind: KlipyKind, item: KlipyItem) {
  if (kind === "gif") {
    return (
      getFormat(item, "md", "gif")?.url ??
      getFormat(item, "sm", "gif")?.url ??
      getFormat(item, "hd", "gif")?.url
    );
  }

  return (
    getFormat(item, "md", "png")?.url ??
    getFormat(item, "md", "webp")?.url ??
    getFormat(item, "sm", "png")?.url ??
    getFormat(item, "sm", "webp")?.url ??
    getFormat(item, "hd", "png")?.url ??
    getFormat(item, "hd", "webp")?.url
  );
}

function useMeasuredWidth() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollWidth, setScrollWidth] = useState(0);

  useLayoutEffect(() => {
    const element = scrollRef.current;

    if (!element || typeof ResizeObserver === "undefined") return;

    const updateWidth = () => setScrollWidth(element.clientWidth);
    const observer = new ResizeObserver(updateWidth);

    updateWidth();
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [scrollRef, scrollWidth] as const;
}

function useImageSizes(urls: string[]) {
  const [sizes, setSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});

  useEffect(() => {
    let active = true;

    for (const url of urls) {
      if (sizes[url]) continue;

      const image = new Image();

      image.onload = () => {
        if (!active) return;

        setSizes((current) => ({
          ...current,
          [url]: {
            width: image.naturalWidth,
            height: image.naturalHeight,
          },
        }));
      };
      image.src = url;
    }

    return () => {
      active = false;
    };
  }, [sizes, urls]);

  return sizes;
}

function MediaGrid({
  hasNextPage = false,
  isFetchingNextPage = false,
  items,
  onLoadMore,
  onSelect,
  resizeWidth,
}: {
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  items: PickerMedia[];
  onLoadMore?: () => void;
  onSelect: (url: string) => void;
  resizeWidth?: number;
}) {
  const [scrollRef, measuredWidth] = useMeasuredWidth();
  const columnWidth = resizeWidth ?? measuredWidth;
  const columnCount = getColumnCount(columnWidth, items.length);
  const columns = distributeByHeight(items, columnCount, (item) => {
    if (!item.width || !item.height) return 1;

    return item.height / item.width;
  });

  function handleScroll(event: React.UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;

    if (
      distanceFromBottom > 240 ||
      !hasNextPage ||
      isFetchingNextPage ||
      !onLoadMore
    ) {
      return;
    }

    onLoadMore();
  }

  useEffect(() => {
    const element = scrollRef.current;

    if (!element || !hasNextPage || isFetchingNextPage || !onLoadMore) return;

    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;

    if (distanceFromBottom <= 240) {
      onLoadMore();
    }
  }, [
    columnCount,
    hasNextPage,
    isFetchingNextPage,
    items.length,
    onLoadMore,
    scrollRef,
  ]);

  return (
    <div
      ref={scrollRef}
      className="min-h-0 w-full flex-1 overflow-y-auto pr-1"
      onScroll={handleScroll}
    >
      <div className="flex w-full items-start gap-2">
        {columns.map((column, columnIndex) => (
          <div key={columnIndex} className="flex min-w-0 flex-1 flex-col gap-2">
            {column.map((item) => (
              <button
                key={item.key}
                className="group overflow-hidden rounded-lg text-left transition hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onSelect(item.url)}
                type="button"
              >
                <img
                  alt={item.alt}
                  className="block h-auto w-full object-contain"
                  height={item.height}
                  loading="lazy"
                  src={item.url}
                  width={item.width}
                />
              </button>
            ))}
          </div>
        ))}
      </div>
      <div>
        {hasNextPage ? (
          <div className="flex h-20 items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 size-4 animate-spin" />
            Loading more...
          </div>
        ) : null}
      </div>
    </div>
  );
}

function KlipyPanel({
  kind,
  onSelect,
  resizeWidth,
  searchString,
}: {
  kind: KlipyKind;
  onSelect: (url: string) => void;
  resizeWidth?: number;
  searchString: string;
}) {
  const query = useInfiniteQuery({
    queryKey: ["klipy", kind, searchString],
    initialPageParam: 1,
    enabled: searchString !== "",
    queryFn: ({ pageParam }) =>
      fetchKlipyPage({
        kind,
        page: Number(pageParam),
        search: searchString,
      }),
    getNextPageParam: (lastPage) =>
      lastPage.hasNext ? lastPage.currentPage + 1 : undefined,
  });
  const items: PickerMedia[] =
    query.data?.pages.flatMap((page) =>
      page.items.flatMap((item) => {
        const displayMedia = pickDisplayMedia(kind, item);
        const selectionUrl = pickSelectionUrl(kind, item);

        if (!displayMedia?.url || !selectionUrl) return [];

        return [
          {
            key: item.id,
            url: selectionUrl,
            alt: item.title ?? "Klipy result",
            width: displayMedia.width,
            height: displayMedia.height,
          },
        ];
      }),
    ) ?? [];

  if (searchString === "") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-5 text-center text-muted-foreground">
        <Search className="size-12" />
        <p className="w-50 text-lg text-foreground">
          {kind === "gif" && 'Try searching for "Funny cat"'}
          {kind === "meme" &&
            'Try searching for "Spiderman pointing at Spiderman"'}
        </p>
      </div>
    );
  }

  if (query.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Loading...
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
        <p>Failed to load {kind === "gif" ? "GIFs" : "memes"}.</p>
        <Button
          onClick={() => void query.refetch()}
          size="sm"
          variant="secondary"
        >
          Try again
        </Button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center text-muted-foreground">
        No {kind === "gif" ? "GIFs" : "memes"} found.
      </div>
    );
  }

  return (
    <MediaGrid
      hasNextPage={query.hasNextPage}
      isFetchingNextPage={query.isFetchingNextPage}
      items={items}
      onLoadMore={() => void query.fetchNextPage()}
      onSelect={onSelect}
      resizeWidth={resizeWidth}
    />
  );
}

function SavedPanel({
  groups,
  onSelect,
  onSavedMediaChange,
  onSavedMediaGroupsChange,
  resizeWidth,
  urls,
}: {
  groups: ChatPickerMediaGroup[];
  onSelect: (url: string) => void;
  onSavedMediaChange: (savedMedia: string[]) => void;
  onSavedMediaGroupsChange: (groups: ChatPickerMediaGroup[]) => void;
  resizeWidth?: number;
  urls: string[];
}) {
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [sort, setSort] = useState("newest");
  const [scrollRef, measuredWidth] = useMeasuredWidth();
  const selectedGroup = groups.find((group) => group.id === selectedGroupId);
  const sortedGroups = [...groups].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const visibleUrls = selectedGroup
    ? urls.filter((url) => selectedGroup.media.includes(url))
    : getUngroupedMedia(urls, groups);
  if (sort === "oldest") visibleUrls.reverse();
  const imageSizes = useImageSizes(visibleUrls);
  const columnWidth = resizeWidth ?? measuredWidth;
  const columnCount = getColumnCount(columnWidth, visibleUrls.length);
  const groupColumnCount = getColumnCount(columnWidth, groups.length);
  const columns = distributeByHeight(visibleUrls, columnCount, (url) => {
    const size = imageSizes[url];

    if (!size?.width || !size.height) return 1;

    return size.height / size.width;
  });

  if (urls.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-center text-muted-foreground">
        Saved media will appear here.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <Select value={sort} onValueChange={(value) => value && setSort(value)}>
        <SelectTrigger
          aria-label="Sort saved media"
          className="w-auto self-start"
        >
          <SelectValue>
            {sort === "newest" ? "Newest first" : "Oldest first"}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="newest">Newest first</SelectItem>
          <SelectItem value="oldest">Oldest first</SelectItem>
        </SelectContent>
      </Select>
      <div
        ref={scrollRef}
        className="min-h-0 w-full flex-1 overflow-y-auto pr-1"
      >
        {selectedGroup ? (
          <div className="mb-2 flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-8 w-8 p-0"
              aria-label="Back to saved groups"
              onClick={() => setSelectedGroupId(null)}
            >
              <ArrowLeft className="size-4" />
            </Button>
            <span className="font-medium">{selectedGroup.name}</span>
          </div>
        ) : groups.length > 0 ? (
          <div
            className="mb-2 grid gap-2"
            style={{
              gridTemplateColumns: `repeat(${groupColumnCount}, minmax(0, 1fr))`,
            }}
          >
            {sortedGroups.map((group) => (
              <button
                key={group.id}
                className="relative h-24 overflow-hidden rounded-lg border bg-muted bg-cover bg-center p-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{
                  backgroundImage: `url(${JSON.stringify(group.media[0])})`,
                }}
                type="button"
                onClick={() => setSelectedGroupId(group.id)}
              >
                <span className="absolute inset-0 bg-black/40" />
                <span className="relative flex h-full items-center justify-center font-medium text-white drop-shadow-sm">
                  {group.name}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        {visibleUrls.length === 0 ? (
          <div className="flex min-h-32 items-center justify-center text-center text-muted-foreground">
            {selectedGroup ? "This group is empty." : "No ungrouped media."}
          </div>
        ) : null}

        <div className="flex w-full items-start gap-2">
          {columns.map((column, columnIndex) => (
            <div
              key={columnIndex}
              className="flex min-w-0 flex-1 flex-col gap-2"
            >
              {column.map((url) => {
                const size = imageSizes[url];

                return (
                  <div
                    key={url}
                    className="group relative overflow-hidden rounded-lg transition hover:border-foreground/30"
                  >
                    <button
                      className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => onSelect(url)}
                      type="button"
                    >
                      <img
                        alt="Saved media"
                        className="block h-auto w-full object-contain"
                        height={size?.height}
                        loading="lazy"
                        src={url}
                        width={size?.width}
                      />
                    </button>
                    <MediaSaveButton
                      defaultSaved
                      onSavedMediaChange={onSavedMediaChange}
                      onSavedMediaGroupsChange={onSavedMediaGroupsChange}
                      url={url}
                    />
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function GifPicker({
  onSelect,
  resizeHeight,
  resizeWidth,
}: {
  onSelect: (url: string) => void;
  resizeHeight?: number;
  resizeWidth?: number;
}) {
  const { load, save } = useStorage();
  const [tab, setTab] = useState<KlipyKind | "saved">("gif");
  const [searchString, setSearchString] = useState("");
  const [debouncedSearchString, setDebouncedSearchString] = useState("");
  const [savedMedia, setSavedMedia] = useState<string[]>([]);
  const [savedMediaGroups, setSavedMediaGroups] = useState<
    ChatPickerMediaGroup[]
  >([]);
  const didLoadLastTabRef = useRef(false);
  const searchDebouncerRef = useRef<Debouncer<(value: string) => void> | null>(
    null,
  );

  if (searchDebouncerRef.current === null) {
    searchDebouncerRef.current = new Debouncer(
      (value) => {
        startTransition(() => {
          setDebouncedSearchString(value.trim());
        });
      },
      { wait: 300 },
    );
  }

  useEffect(() => {
    return () => {
      searchDebouncerRef.current?.cancel();
    };
  }, []);

  useEffect(() => {
    if (tab !== "saved") return;

    void Promise.all([
      load("chat_picker_saved_media"),
      load("chat_picker_saved_media_groups"),
    ]).then(([nextSavedMedia, nextGroups]) => {
      setSavedMedia(nextSavedMedia);
      setSavedMediaGroups(nextGroups);
    });
  }, [load, tab]);

  useEffect(() => {
    void load("chat_picker_last_tab").then((savedTab) => {
      setTab(savedTab);
      didLoadLastTabRef.current = true;
    });
  }, [load]);

  useEffect(() => {
    if (!didLoadLastTabRef.current) return;

    void save("chat_picker_last_tab", tab);
  }, [save, tab]);

  function handleTabChange(nextTab: string) {
    if (nextTab !== "gif" && nextTab !== "meme" && nextTab !== "saved") return;

    setTab(nextTab);
  }

  function handleSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value;

    setSearchString(nextValue);
    searchDebouncerRef.current?.maybeExecute(nextValue);
  }

  return (
    <Tabs
      className="h-full min-h-0 w-full overflow-hidden"
      style={resizeHeight ? { height: `${resizeHeight}px` } : undefined}
      value={tab}
      onValueChange={handleTabChange}
    >
      <TabsList className="w-full">
        <TabsTrigger value="gif">GIFs</TabsTrigger>
        <TabsTrigger value="meme">Memes</TabsTrigger>
        <TabsTrigger value="saved">Saved</TabsTrigger>
      </TabsList>
      <TabsContent value="gif" className="flex min-h-0 w-full flex-col gap-2">
        <Input
          placeholder="Search Klipy..."
          value={searchString}
          onChange={handleSearchChange}
        />
        <KlipyPanel
          kind="gif"
          onSelect={onSelect}
          resizeWidth={resizeWidth}
          searchString={debouncedSearchString}
        />
      </TabsContent>
      <TabsContent value="meme" className="flex min-h-0 w-full flex-col gap-2">
        <Input
          placeholder="Search Klipy..."
          value={searchString}
          onChange={handleSearchChange}
        />
        <KlipyPanel
          kind="meme"
          onSelect={onSelect}
          resizeWidth={resizeWidth}
          searchString={debouncedSearchString}
        />
      </TabsContent>
      <TabsContent
        value="saved"
        className="flex min-h-0 w-full flex-col overflow-hidden"
      >
        <SavedPanel
          groups={savedMediaGroups}
          onSelect={onSelect}
          onSavedMediaChange={setSavedMedia}
          onSavedMediaGroupsChange={setSavedMediaGroups}
          resizeWidth={resizeWidth}
          urls={savedMedia}
        />
      </TabsContent>
    </Tabs>
  );
}
