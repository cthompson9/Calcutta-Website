import { Router } from "express";
import healthRouter from "./health";
import teamsRouter from "./teams";
import biddersRouter from "./bidders";
import summaryRouter from "./summary";
import seasonsRouter from "./seasons";
import calcuttasRouter from "./calcuttas";
import resultsRouter from "./results";
import tradesRouter from "./trades";
import mtmRouter from "./mtm";
import auctionImportRouter from "./auctionImport";
import periodsRouter from "./periods";
import nflStandingsImportRouter from "./nflStandingsImport";
import jobsRouter from "./jobs";
import v2AgentRouter from "./v2Agent";
import normalizedHistoricalRouter from "./normalizedHistorical";

const router = Router();

router.use(healthRouter);
router.use(teamsRouter);
router.use(biddersRouter);
router.use(summaryRouter);
router.use(seasonsRouter);
router.use(calcuttasRouter);
router.use(resultsRouter);
router.use(tradesRouter);
router.use(mtmRouter);
router.use(auctionImportRouter);
router.use(periodsRouter);
router.use(nflStandingsImportRouter);
router.use(jobsRouter);
router.use(v2AgentRouter);
router.use(normalizedHistoricalRouter);

export default router;
