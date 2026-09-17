import { z } from "zod";

export const mathQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  question: z.string().min(1).max(500),
  suggestedAnswer: z.string().max(200),
});
export type MathQuestion = z.infer<typeof mathQuestionSchema>;

export const mathSolveRequestSchema = z.object({
  image: z
    .string()
    .max(8_000_000)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/),
  clarifications: z
    .array(
      z.object({
        question: z.string().min(1).max(500),
        answer: z.string().trim().min(1).max(200),
      }),
    )
    .max(24)
    .default([]),
});
export type MathSolveRequest = z.input<typeof mathSolveRequestSchema>;

export type MathSolveEvent =
  | { type: "reasoning-delta"; delta: string }
  | { type: "reasoning-done" }
  | { type: "questions"; questions: MathQuestion[] }
  | { type: "python-start"; code: string }
  | { type: "python-result"; output: string; success: boolean }
  | { type: "text-delta"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };
