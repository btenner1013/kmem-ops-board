/**
 * Approved, wholly synthetic DD1801 test scenario.
 *
 * These values were authored for automated tests and are not copied, adapted,
 * or transcribed from an operational flight plan.
 */
export const SYNTHETIC_DD1801_FIXTURE_ID = "KMEM-DD1801-SYNTHETIC-V1";

export const SYNTHETIC_DD1801 = Object.freeze({
  aircraftIdentification: "LAB731",
  flightRules: "I",
  typeOfFlight: "M",
  aircraftType: "C17",
  wakeCategory: "H",
  equipment: "SFGHIRWY",
  surveillance: "C2",
  departure: "ZZZA",
  departureTime: "1210",
  speed: "N0320",
  level: "F240",
  dottedRoute: "SIM1A.MOCKA ALPHA Q42 BRAVO DCT CHARL T7 DELTA TRIAL.SIM2B",
  route: "SIM1A MOCKA ALPHA Q42 BRAVO DCT CHARL T7 DELTA TRIAL SIM2B",
  destination: "ZZZB",
  totalEet: "0145",
  alternate: "ZZZC",
  secondAlternate: "",
  otherInformation: "PBN/A1B1 DOF/300101 REG/TEST731 OPR/TEST PER/C",
  endurance: "0415",
  personsOnBoard: "007",
  dinghyNumber: "02",
  dinghyCapacity: "016",
  dinghyColor: "BLUE",
  remarks: "WHOLLY SYNTHETIC TRAINING SCENARIO",
  aircraftSerial: "SIM-0001",
});

export const SYNTHETIC_DD1801_FPL = `(FPL-LAB731-IM
-C17/H-SFGHIRWY/C2
-ZZZA1210
-N0320F240 SIM1A MOCKA ALPHA Q42 BRAVO DCT CHARL T7 DELTA TRIAL SIM2B
-ZZZB0145 ZZZC
-PBN/A1B1 DOF/300101 REG/TEST731 OPR/TEST PER/C)`;
