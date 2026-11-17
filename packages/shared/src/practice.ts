// Guided-practice transport contract: session/question state the web header renders and the browser-side practice actions.
import { z } from "zod";
import { idSchema, isoDateSchema } from "./contracts.js";

// Which feedback and progress affordances a session uses; chosen per session by the MCP caller.
export const practiceFeedbackOptionsSchema = z.object({
  inkMarks: z.boolean().default(true),
  card: z.boolean().default(false),
  solution: z.boolean().default(false),
  retry: z.boolean().default(false),
});

export const practiceProgressOptionsSchema = z.object({
  bar: z.boolean().default(true),
  runningScore: z.boolean().default(false),
  mastery: z.boolean().default(false),
  status: z.boolean().default(false),
});

export const practiceOptionsSchema = z.object({
  feedback: practiceFeedbackOptionsSchema.default({
    inkMarks: true,
    card: false,
    solution: false,
    retry: false,
  }),
  progress: practiceProgressOptionsSchema.default({
    bar: true,
    runningScore: false,
    mastery: false,
    status: false,
  }),
});

// awaiting_work: the user is writing; submitted: Done pressed, waiting for Claude;
// graded: marks are on the page and the user chooses Next/Retry; closed: moved past.
export const practiceQuestionStateSchema = z.enum([
  "awaiting_work",
  "submitted",
  "graded",
  "closed",
]);

export const practiceQuestionSchema = z.object({
  id: idSchema,
  index: z.number().int().nonnegative(),
  pageIndex: z.number().int().nonnegative(),
  state: practiceQuestionStateSchema,
  attempt: z.number().int().positive(),
  maxPoints: z.number().positive(),
  // Score of the first graded attempt; retries never replace it.
  points: z.number().nonnegative().nullable(),
  // Score of the latest graded attempt (equals `points` without retries).
  latestPoints: z.number().nonnegative().nullable(),
  topics: z.array(z.string()),
});

export const practiceSessionSchema = z.object({
  id: idSchema,
  noteId: idSchema,
  title: z.string(),
  totalQuestions: z.number().int().positive(),
  status: z.enum(["active", "complete"]),
  statusText: z.string().nullable(),
  options: practiceOptionsSchema,
  questions: z.array(practiceQuestionSchema),
  updatedAt: isoDateSchema,
});

// POST /api/practice/questions/:questionId/action body.
export const practiceActionSchema = z.object({
  action: z.enum(["next", "retry"]),
});

export type PracticeOptions = z.infer<typeof practiceOptionsSchema>;
export type PracticeQuestionState = z.infer<typeof practiceQuestionStateSchema>;
export type PracticeQuestion = z.infer<typeof practiceQuestionSchema>;
export type PracticeSession = z.infer<typeof practiceSessionSchema>;
export type PracticeAction = z.infer<typeof practiceActionSchema>;
