import { Router } from "express";
import healthRouter from "./health";
import teamsRouter from "./teams";
import biddersRouter from "./bidders";
import summaryRouter from "./summary";

const router = Router();

router.use(healthRouter);
router.use(teamsRouter);
router.use(biddersRouter);
router.use(summaryRouter);

export default router;
