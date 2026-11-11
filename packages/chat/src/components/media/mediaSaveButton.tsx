import {
  Button,
  buttonVariants,
  cn,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useIsMobile,
} from "@nonanium/ui";
import type { ChatPickerMediaGroup } from "@tensamin/shared/data";
import { useStorage } from "@tensamin/storage/context";
import { Ellipsis, Star } from "lucide-react";
import { useEffect, useState } from "react";
import {
  assignMediaToGroup,
  createMediaGroup,
  getMediaGroupId,
} from "./mediaGroups";

export default function MediaSaveButton({
  className,
  defaultSaved = false,
  onSavedMediaChange,
  onSavedMediaGroupsChange,
  url,
}: {
  className?: string;
  defaultSaved?: boolean;
  onSavedMediaChange?: (savedMedia: string[]) => void;
  onSavedMediaGroupsChange?: (groups: ChatPickerMediaGroup[]) => void;
  url: string;
}) {
  const { load, save } = useStorage();
  const isMobile = useIsMobile();
  const [savedMedia, setSavedMedia] = useState<string[] | null>(null);
  const [groups, setGroups] = useState<ChatPickerMediaGroup[] | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [newGroupName, setNewGroupName] = useState("");
  const isSaved = savedMedia ? savedMedia.includes(url) : defaultSaved;
  const sortedGroups = [...(groups ?? [])].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const normalizedNewGroupName = newGroupName.trim().toLocaleLowerCase();
  const canCreateGroup =
    normalizedNewGroupName.length > 0 &&
    !(groups ?? []).some(
      (group) => group.name.toLocaleLowerCase() === normalizedNewGroupName,
    );

  useEffect(() => {
    void Promise.all([
      load("chat_picker_saved_media"),
      load("chat_picker_saved_media_groups"),
    ]).then(([nextSavedMedia, nextGroups]) => {
      setSavedMedia(nextSavedMedia);
      setGroups(nextGroups);
    });
  }, [load]);

  async function handleSaveClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();

    const [currentSavedMedia, currentGroups] = await Promise.all([
      load("chat_picker_saved_media"),
      load("chat_picker_saved_media_groups"),
    ]);
    const willUnsave = currentSavedMedia.includes(url);
    const nextSavedMedia = willUnsave
      ? currentSavedMedia.filter((item) => item !== url)
      : [url, ...currentSavedMedia];

    setSavedMedia(nextSavedMedia);
    onSavedMediaChange?.(nextSavedMedia);
    if (willUnsave) {
      const nextGroups = assignMediaToGroup(currentGroups, null, url);
      setGroups(nextGroups);
      onSavedMediaGroupsChange?.(nextGroups);
      await Promise.all([
        save("chat_picker_saved_media", nextSavedMedia),
        save("chat_picker_saved_media_groups", nextGroups),
      ]);
      return;
    }

    await save("chat_picker_saved_media", nextSavedMedia);
  }

  async function handleGroupClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();

    const currentGroups = await load("chat_picker_saved_media_groups");
    setGroups(currentGroups);
    setSelectedGroupId(getMediaGroupId(currentGroups, url));
    setNewGroupName("");
    setDialogOpen(true);
  }

  async function handleGroupSave() {
    const currentGroups = await load("chat_picker_saved_media_groups");
    const nextGroups = assignMediaToGroup(currentGroups, selectedGroupId, url);

    setGroups(nextGroups);
    onSavedMediaGroupsChange?.(nextGroups);
    await save("chat_picker_saved_media_groups", nextGroups);
    setDialogOpen(false);
  }

  async function handleCreateGroup() {
    if (!canCreateGroup) return;

    const currentGroups = await load("chat_picker_saved_media_groups");
    const groupId = crypto.randomUUID();
    const nextGroups = createMediaGroup(
      currentGroups,
      groupId,
      newGroupName,
      url,
    );

    setGroups(nextGroups);
    setSelectedGroupId(groupId);
    setNewGroupName("");
    onSavedMediaGroupsChange?.(nextGroups);
    await save("chat_picker_saved_media_groups", nextGroups);
    setDialogOpen(false);
  }

  return (
    <>
      <span
        className={cn(
          buttonVariants({ variant: "secondary" }),
          "absolute right-1 top-1 z-10 h-auto gap-0 overflow-hidden p-0 transition-all",
          !isMobile &&
            "-translate-y-2 opacity-0 hover:bg-muted! group-hover:translate-y-0 group-hover:opacity-100",
          className,
        )}
      >
        <Button
          aria-label={isSaved ? "Remove from favourites" : "Add to favourites"}
          variant="ghost"
          className={cn(
            isMobile ? "h-10 w-10" : "h-9 w-9",
            isSaved && "rounded-r-none",
            !isMobile && "hover:bg-transparent!",
            "border-0! p-0",
          )}
          onClick={handleSaveClick}
        >
          <Star
            color="var(--primary-foreground-alt)"
            className={cn(
              "size-4.5 stroke-1.5!",
              isSaved ? "fill-(--primary-foreground-alt)" : "",
            )}
          />
        </Button>
        {isSaved ? (
          <Button
            aria-label="Organize favourite groups"
            variant="ghost"
            className={cn(
              isMobile ? "h-10 w-10" : "h-9 w-9",
              !isMobile && "hover:bg-transparent!",
              "rounded-l-none border-0! p-0",
            )}
            onClick={handleGroupClick}
          >
            <Ellipsis className="size-4.5 stroke-1.5!" />
          </Button>
        ) : null}
      </span>

      {dialogOpen ? (
        <span
          aria-hidden="true"
          className="fixed inset-0 z-40"
          style={{
            background:
              "color-mix(in oklab, var(--background) 30%, transparent)",
          }}
        />
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent onClick={(event) => event.stopPropagation()}>
          <DialogHeader>
            <DialogTitle>Organize saved media</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="saved-media-group">Select group</Label>
              <Select
                value={selectedGroupId ?? "ungrouped"}
                onValueChange={(value) =>
                  setSelectedGroupId(value === "ungrouped" ? null : value)
                }
              >
                <SelectTrigger id="saved-media-group" className="w-full">
                  <SelectValue>
                    {selectedGroupId === null
                      ? "Ungrouped"
                      : groups?.find((group) => group.id === selectedGroupId)
                          ?.name}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent className="p-1">
                  <SelectItem value="ungrouped">Ungrouped</SelectItem>
                  {sortedGroups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="new-saved-media-group">New group</Label>
              <div className="flex gap-2">
                <Input
                  id="new-saved-media-group"
                  placeholder="Group name"
                  value={newGroupName}
                  onChange={(event) => setNewGroupName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void handleCreateGroup();
                  }}
                />
                <Button disabled={!canCreateGroup} onClick={handleCreateGroup}>
                  Create Group
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleGroupSave}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
