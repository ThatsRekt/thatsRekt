// Type augmentations for `otomato-sdk@2.0.0`.
//
// The published `.d.ts` for this version of the SDK is stale relative
// to `dist/src/constants/Blocks.js`: the runtime exposes triggers and
// actions (X_POST_TRIGGER, SPLIT, HTTP_REQUEST, AI, IF, …) that the
// type definitions don't declare. Rather than `any`-cast at every use
// site, we declare ONLY the entries the detector needs and re-export
// `ACTIONS` / `TRIGGERS` through the augmented type. If the SDK ships
// updated types in a future version, drop this file and import
// directly from `otomato-sdk` again.
//
// We intentionally type each block as `unknown` (then narrow at the
// call site via `as` if needed) — the SDK's `Action` / `Trigger`
// constructors accept any block descriptor and read the runtime
// fields. We don't want to mirror the entire descriptor shape here;
// that's the SDK's job.

import {
  ACTIONS as RawACTIONS,
  TRIGGERS as RawTRIGGERS,
  type Parameter,
} from 'otomato-sdk';

// BlockDescriptor matches the shape the SDK's `Action` and `Trigger`
// constructors expect — it's defined inline in the SDK's exported types
// (we replicated the required fields here). Extra runtime fields like
// `dynamicName` / `examples` are ignored by the SDK reader and so are
// absent from this shape.
export interface BlockDescriptor {
  readonly name: string;
  readonly type: number;
  readonly description: string;
  readonly blockId: number;
  readonly image: string;
  readonly parameters: Parameter[];
  readonly output?: { readonly [key: string]: string };
}

export interface ActionsAugmented {
  readonly CORE: {
    readonly SPLIT: { readonly SPLIT: BlockDescriptor };
    readonly CONDITION: { readonly IF: BlockDescriptor };
    readonly HTTP_REQUEST: { readonly HTTP_REQUEST: BlockDescriptor };
    readonly HELPER: {
      readonly TIMESTAMP: BlockDescriptor;
    };
  };
  readonly AI: {
    readonly AI: { readonly AI: BlockDescriptor };
  };
  readonly NOTIFICATIONS: {
    readonly EMAIL: { readonly SEND_EMAIL: BlockDescriptor };
  };
}

export interface TriggersAugmented {
  readonly SOCIALS: {
    readonly X: {
      readonly X_POST_TRIGGER: BlockDescriptor;
    };
  };
}

// Cast through `unknown` so TS allows the structural difference.
export const ACTIONS = RawACTIONS as unknown as ActionsAugmented;
export const TRIGGERS = RawTRIGGERS as unknown as TriggersAugmented;
