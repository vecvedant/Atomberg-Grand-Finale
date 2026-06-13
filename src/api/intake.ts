/**
 * Public customer intake (the universal "raise a support request" form).
 * No authentication: anyone with the link can submit. Each submission auto-
 * creates a task, auto-routed to the least-loaded manager's pool, with the
 * problem, purchase date, an optional bill photo, and an auto-suggested warranty
 * flag. Returns a join link the customer uses to enter the call.
 */
import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.ts';
import { fileRepo, sessionRepo } from '../db/repos.ts';
import { createIntakeTask } from '../services/sessions.ts';

export const intakeRouter = Router();

const BILL_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, BILL_MIME.has(file.mimetype)),
});

const schema = z.object({
  name: z.string().min(1).max(60),
  phone: z.string().min(7).max(20),
  email: z.string().email().max(120),
  problem: z.string().min(1).max(2000),
  title: z.string().max(120).optional(),
  purchaseDate: z.string().max(40).optional(),
  warranty: z.enum(['yes', 'no', 'unsure']).optional(),
  // Customer-chosen preferred call time (ISO). Optional — blank means "as soon as possible".
  scheduledAt: z.string().max(40).optional(),
});

intakeRouter.post('/', upload.single('bill'), (req, res) => {
  const parsed = schema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid input' });
    return;
  }
  const d = parsed.data;

  let purchaseDate: string | null = null;
  if (d.purchaseDate) {
    const dt = new Date(d.purchaseDate);
    if (!Number.isNaN(dt.getTime())) purchaseDate = dt.toISOString().slice(0, 10);
  }

  // A preferred call time only counts if it parses and is in the future.
  let scheduledAt: string | null = null;
  if (d.scheduledAt) {
    const st = new Date(d.scheduledAt);
    if (!Number.isNaN(st.getTime()) && st.getTime() > Date.now()) scheduledAt = st.toISOString();
  }

  const task = createIntakeTask({
    title: d.title?.trim() || d.problem.trim().slice(0, 60),
    description: d.problem.trim(),
    requesterName: d.name.trim(),
    requesterPhone: d.phone.trim(),
    requesterEmail: d.email.trim(),
    purchaseDate,
    warrantyStatus: d.warranty ?? null,
    scheduledAt,
  });

  // Optional bill photo — stored under the new task, randomized filename.
  if (req.file) {
    const dir = path.join(config.paths.uploads, task.id);
    mkdirSync(dir, { recursive: true });
    const ext = path.extname(req.file.originalname).slice(0, 12).replace(/[^a-zA-Z0-9.]/g, '');
    const storedName = `${randomUUID()}${ext}`;
    writeFileSync(path.join(dir, storedName), req.file.buffer);
    const f = fileRepo.create({
      sessionId: task.id,
      uploaderParticipantId: null,
      originalName: req.file.originalname.slice(0, 200),
      storedName,
      mime: req.file.mimetype,
      size: req.file.size,
    });
    sessionRepo.setBill(task.id, f.id);
  }

  res.status(201).json({
    ok: true,
    reference: task.ref,
    joinUrl: task.inviteUrl,
    routed: !!task.managerId,
    warrantyAuto: task.warrantyAuto,
    scheduledAt: task.scheduled_at ?? null,
  });
});
