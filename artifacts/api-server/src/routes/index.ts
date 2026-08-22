import { Router } from "express";
import healthRouter from "./health";
import teamsRouter from "./teams";
import biddersRouter from "./bidders";
import summaryRouter from "./summary";
import seasonsRouter from "./seasons";
import resultsRouter from "./results";
import tradesRouter from "./trades";
import mtmRouter from "./mtm";
import mcpRouter from "./mcp";
import auctionImportRouter from "./auctionImport";
import periodsRouter from "./periods";

const router = Router();

router.use(healthRouter);
router.use(teamsRouter);
router.use(biddersRouter);
router.use(summaryRouter);
router.use(seasonsRouter);
router.use(resultsRouter);
router.use(tradesRouter);
router.use(mtmRouter);
router.use(mcpRouter);
router.use(auctionImportRouter);
router.use(periodsRouter);

export default router;
