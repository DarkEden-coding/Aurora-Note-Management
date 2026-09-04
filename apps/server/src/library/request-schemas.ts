// Re-export shared request schemas so server routes cannot drift from transport contracts.
export {
  backgroundSchema,
  canvasModeSchema as noteCanvasModeSchema,
  noteKindSchema,
} from "@aurora/shared";
