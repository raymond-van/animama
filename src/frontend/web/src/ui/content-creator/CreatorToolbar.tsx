import {
  Code2Icon,
  FilePlus2Icon,
  FolderOpenIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PencilIcon,
  SaveIcon,
  Undo2Icon,
  Redo2Icon,
  UploadIcon,
} from "lucide-react";
import { useEffect, useRef, type ReactNode, type Ref } from "react";

import {
  CreatorHistoryShortcut,
  getCreatorHistoryShortcutLabels,
  type CreatorHistoryController,
} from "@/ui/creator-history/CreatorHistory";

import { cn } from "@/lib/utils";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";
import { Input } from "@/ui/components/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/ui/components/tooltip";
import { CreatorHeaderDocument } from "./CreatorHeaderDocument";
import { CreatorValidationIndicator } from "./CreatorValidationIndicator";
import { CreatorLoadPicker, type CreatorEffectType } from "./CreatorLoadPicker";

export type CreatorDocumentStatus = {
  label: string;
  tone?: "saved" | "dirty" | "warning" | "error";
  /** Actionable detail shown below a compact failure status. */
  tooltip?: ReactNode;
};

type CreatorToolbarProps = {
  history?: Pick<
    CreatorHistoryController<unknown>,
    "canUndo" | "canRedo" | "undo" | "redo"
  >;
  historyDisabled?: boolean;
  typeLabel: string;
  typeIcon: ReactNode;
  contentType?: CreatorEffectType;
  documentName?: string;
  onDocumentNameChange?: (name: string) => void;
  documentNameInputRef?: Ref<HTMLInputElement>;
  documentNameInvalid?: boolean;
  documentNameDisabled?: boolean;
  documentControl?: ReactNode;
  status: CreatorDocumentStatus;
  validationMessages?: readonly string[];
  onNew: () => void;
  onImport: () => void;
  onJson: () => void;
  onLibrary?: () => void;
  onSave: () => void;
  newDisabled?: boolean;
  importDisabled?: boolean;
  jsonDisabled?: boolean;
  libraryDisabled?: boolean;
  saveDisabled: boolean;
  saveBusy: boolean;
  saveLabel: string;
  libraryLabel?: string;
  /** The creator's Simple | Advanced switch (`CreatorModeSwitch`), before the domain actions. */
  modeControl?: ReactNode;
  domainActions?: ReactNode;
  /** Interactive catalog status participates in layout beside document actions. */
  contentHealth?: ReactNode;
};

/** Action-sized FX document controls, with the name visible at every width. */
export function CreatorToolbar({
  history,
  historyDisabled = false,
  typeLabel,
  typeIcon,
  contentType,
  documentName,
  onDocumentNameChange,
  documentNameInputRef,
  documentNameInvalid,
  documentNameDisabled,
  documentControl,
  status,
  validationMessages = [],
  onNew,
  onImport,
  onJson,
  onLibrary,
  onSave,
  newDisabled,
  importDisabled,
  jsonDisabled,
  libraryDisabled,
  saveDisabled,
  saveBusy,
  saveLabel,
  libraryLabel = "Library",
  modeControl,
  domainActions,
  contentHealth,
}: CreatorToolbarProps) {
  const shortcuts = getCreatorHistoryShortcutLabels();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (documentNameInvalid) inputRef.current?.focus();
  }, [documentNameInvalid]);
  return (
    <header className="[&_button:disabled]:text-muted-foreground bg-background relative z-40 w-full shrink-0 px-2 py-2 sm:pr-3 sm:pl-[calc(var(--app-shell-sidebar-inset)+1rem)] lg:bg-transparent lg:py-3 lg:pr-4 lg:pl-[calc(var(--app-shell-sidebar-inset)+1rem)] lg:transition-[padding-left] lg:duration-150 lg:ease-in-out xl:pr-8 xl:pl-[calc(var(--app-shell-sidebar-inset)+2rem)] [&_button:disabled]:opacity-100">
      {history ? (
        <CreatorHistoryShortcut
          controller={history}
          isBusy={historyDisabled || saveBusy}
        />
      ) : null}
      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] grid-rows-[auto_auto] items-center gap-2 lg:grid-cols-[auto_auto_auto_auto_minmax(120px,1fr)_auto] lg:grid-rows-1 lg:items-start lg:gap-1.5 2xl:gap-3">
        <div className="border-border/70 bg-background col-start-1 row-start-1 flex h-11 min-w-0 items-center justify-center gap-2 rounded-xl border px-3 text-sm font-medium shadow-sm lg:h-12 [&_svg]:size-4 [&_svg]:shrink-0">
          {typeIcon}
          {/* A mode switch needs the room the type label takes, so with one
              the type shows as its icon; the text stays for assistive tech. */}
          <span className={cn("truncate", modeControl && "sr-only")}>
            {typeLabel}
          </span>
        </div>
        <Button
          type="button"
          variant="outline"
          aria-label="New"
          title="New"
          className="dark:bg-background dark:hover:bg-accent col-start-2 row-start-1 hidden size-12 rounded-xl p-0 shadow-sm lg:inline-flex 2xl:w-auto 2xl:min-w-[82px] 2xl:px-3"
          disabled={newDisabled}
          onClick={onNew}
        >
          <FilePlus2Icon className="size-4" />
          <span className="hidden 2xl:inline">New</span>
        </Button>
        {contentType ? (
          <CreatorLoadPicker
            contentType={contentType}
            disabled={libraryDisabled}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            className="dark:bg-background dark:hover:bg-accent col-start-2 row-start-1 size-11 rounded-xl p-0 shadow-sm lg:col-start-3 lg:size-12 2xl:w-auto 2xl:px-4"
            aria-label={libraryLabel}
            title={libraryLabel}
            disabled={libraryDisabled}
            onClick={onLibrary}
          >
            <FolderOpenIcon className="size-4" />
            <span className="hidden 2xl:inline">{libraryLabel}</span>
          </Button>
        )}
        <div className="border-border/70 bg-background col-start-4 row-start-1 hidden h-12 shrink-0 items-center rounded-xl border px-1 shadow-sm lg:flex">
          <CreatorIconAction
            label="Import"
            icon={<UploadIcon />}
            disabled={importDisabled}
            onClick={onImport}
          />
          <CreatorIconAction
            label="View JSON"
            icon={<Code2Icon />}
            disabled={jsonDisabled}
            onClick={onJson}
          />
          {history ? (
            <>
              <CreatorIconAction
                label={`Undo · ${shortcuts.undo}`}
                icon={<Undo2Icon />}
                disabled={historyDisabled || saveBusy || !history.canUndo}
                onClick={history.undo}
              />
              <CreatorIconAction
                label={`Redo · ${shortcuts.redo}`}
                icon={<Redo2Icon />}
                disabled={historyDisabled || saveBusy || !history.canRedo}
                onClick={history.redo}
              />
            </>
          ) : null}
        </div>
        <CreatorHeaderDocument
          className="col-span-2 col-start-1 row-start-2 flex min-w-0 justify-center lg:col-span-1 lg:col-start-5 lg:row-start-1"
          widthClassName="w-full min-w-0 lg:max-w-[380px]"
        >
          <div
            className={cn(
              "border-border/70 bg-background flex h-11 min-w-0 items-center gap-1 rounded-xl border px-3 shadow-sm lg:h-12",
              documentNameInvalid &&
                "border-destructive/50 ring-destructive/40 ring-1",
            )}
          >
            {documentControl ??
              (onDocumentNameChange ? (
                <>
                  <span className="text-muted-foreground text-2xs inline-flex shrink-0 items-center gap-1 font-medium">
                    <PencilIcon className="size-3" />
                    Name
                  </span>
                  <Input
                    ref={(element) => {
                      inputRef.current = element;
                      if (typeof documentNameInputRef === "function")
                        documentNameInputRef(element);
                      else if (documentNameInputRef)
                        documentNameInputRef.current = element;
                    }}
                    value={documentName ?? ""}
                    onChange={(event) =>
                      onDocumentNameChange(event.target.value)
                    }
                    aria-label={`${typeLabel} name`}
                    aria-invalid={documentNameInvalid}
                    disabled={documentNameDisabled}
                    placeholder={`New ${typeLabel}`}
                    className="h-7 min-w-0 flex-1 border-0 bg-transparent px-2 text-sm font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
                  />
                </>
              ) : (
                <div className="min-w-0 flex-1 truncate text-sm font-medium">
                  {documentName}
                </div>
              ))}
            <CreatorToolbarStatus status={status} />
            <CreatorValidationIndicator messages={validationMessages} />
            {contentHealth}
          </div>
        </CreatorHeaderDocument>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="dark:bg-background dark:hover:bg-accent col-start-3 row-start-2 size-11 rounded-xl p-0 shadow-sm lg:hidden"
              aria-label="More creator actions"
            >
              <MoreHorizontalIcon className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={8}
            className="w-60 rounded-xl p-1.5"
          >
            <DropdownMenuItem
              className="min-h-11 gap-3 rounded-lg"
              disabled={newDisabled}
              onSelect={onNew}
            >
              <FilePlus2Icon className="size-4" />
              New
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 gap-3 rounded-lg"
              disabled={importDisabled}
              onSelect={onImport}
            >
              <UploadIcon className="size-4" />
              Import
            </DropdownMenuItem>
            <DropdownMenuItem
              className="min-h-11 gap-3 rounded-lg"
              disabled={jsonDisabled}
              onSelect={onJson}
            >
              <Code2Icon className="size-4" />
              View JSON
            </DropdownMenuItem>
            {history ? (
              <>
                <DropdownMenuItem
                  className="min-h-11 gap-3 rounded-lg"
                  disabled={historyDisabled || saveBusy || !history.canUndo}
                  onSelect={history.undo}
                >
                  <Undo2Icon className="size-4" />
                  <span>Undo</span>
                  <span className="text-muted-foreground ml-auto text-xs">
                    {shortcuts.undo}
                  </span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="min-h-11 gap-3 rounded-lg"
                  disabled={historyDisabled || saveBusy || !history.canRedo}
                  onSelect={history.redo}
                >
                  <Redo2Icon className="size-4" />
                  <span>Redo</span>
                  <span className="text-muted-foreground ml-auto text-xs">
                    {shortcuts.redo}
                  </span>
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="col-start-3 row-start-1 flex h-11 items-center gap-1.5 lg:col-start-6 lg:h-12">
          {modeControl}
          {domainActions}
          <Button
            type="button"
            variant="default"
            className="hover:bg-primary size-11 rounded-xl p-0 shadow-sm lg:h-12 lg:w-auto lg:min-w-[88px] lg:px-3"
            disabled={saveDisabled}
            onClick={onSave}
            aria-label={saveLabel}
            title={saveLabel}
          >
            {saveBusy ? (
              <LoaderCircleIcon className="size-4 animate-spin motion-reduce:animate-none" />
            ) : (
              <SaveIcon className="size-4" />
            )}
            <span className="hidden lg:inline">{saveLabel}</span>
          </Button>
        </div>
      </div>
    </header>
  );
}

/** Keep save state compact while retaining its full accessible explanation. */
function CreatorToolbarStatus({ status }: { status: CreatorDocumentStatus }) {
  const label =
    typeof status.tooltip === "string"
      ? `${status.label}: ${status.tooltip}`
      : status.label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="focus-visible:ring-ring inline-flex size-6 shrink-0 items-center justify-center rounded-full outline-none focus-visible:ring-2"
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2 rounded-full",
              status.tone === "saved" && "bg-success",
              (!status.tone || status.tone === "dirty") && "bg-primary",
              status.tone === "warning" && "bg-warning",
              status.tone === "error" && "bg-destructive",
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={8}
        className="max-w-sm text-left"
      >
        {status.tooltip ?? status.label}
      </TooltipContent>
    </Tooltip>
  );
}

function CreatorIconAction({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className="[&_svg]:size-3.5"
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={8}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}
