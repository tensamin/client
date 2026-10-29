import { cloneElement } from "react";
import type { MouseEvent as ReactMouseEvent, ReactElement, Ref } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@nonanium/ui";

export type CallButtonProps = {
  className?: string;
  iconSize?: number;
  tooltip?: string;
  portalContainer?: HTMLElement;
};

export function iconScale(iconSize?: number) {
  return { scale: (iconSize ? iconSize + 100 : 100) + "%" };
}

export function withButtonTooltip(
  trigger: ReactElement<{
    "aria-label"?: string;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    ref?: Ref<HTMLElement>;
  }>,
  content?: string,
  portalContainer?: HTMLElement,
) {
  if (!content) return trigger;

  return (
    <Tooltip>
      <TooltipTrigger
        render={({ ref, onClick }) =>
          cloneElement(trigger, {
            "aria-label": trigger.props["aria-label"] ?? content,
            ref,
            onClick: (event) => {
              onClick?.(event);
              trigger.props.onClick?.(event);
            },
          })
        }
      />
      <TooltipContent portalProps={{ container: portalContainer }}>
        {content}
      </TooltipContent>
    </Tooltip>
  );
}
