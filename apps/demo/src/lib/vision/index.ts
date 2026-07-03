export {
  classifyJobLogPhoto,
  type CvConfidence,
  type CvPrediction,
  type ClassifyInput,
  type ClassifyResult,
} from "./classify";
export {
  insertCvLabel,
  confirmCvLabel,
  getCvLabelById,
  getLatestCvLabelForEntry,
  listLatestCvLabelsForAppointment,
  type CvLabelRow,
} from "./store";
