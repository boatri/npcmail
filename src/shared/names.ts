// Name pools for generating identities like jane.moreau@yourdomain.com.
// ASCII-only so the local part is always a valid, unremarkable email address.
// Intentionally diverse so generated signups don't share an obvious fingerprint.

export const FIRST_NAMES: string[] = [
  "james", "mary", "john", "linda", "david", "susan", "michael", "karen",
  "thomas", "nancy", "daniel", "laura", "matthew", "emily", "andrew", "anna",
  "ryan", "olivia", "ethan", "chloe", "lucas", "grace", "henry", "alice",
  "oscar", "ruby", "leo", "ella", "max", "ivy", "felix", "nora",
  "carlos", "maria", "diego", "lucia", "javier", "carmen", "andres", "elena",
  "mateo", "sofia", "pablo", "valeria", "ricardo", "camila", "fernando", "ines",
  "pierre", "claire", "louis", "margot", "hugo", "juliette", "antoine", "elise",
  "marco", "giulia", "luca", "chiara", "matteo", "alessia", "paolo", "elisa",
  "lars", "freja", "erik", "astrid", "nils", "ingrid", "anders", "maja",
  "jan", "eva", "piotr", "zofia", "marek", "hanna", "tomas", "lena",
  "kenji", "yuki", "hiro", "aiko", "takeshi", "mei", "satoshi", "hana",
  "arjun", "priya", "rohan", "anika", "vikram", "diya", "karan", "isha",
  "omar", "layla", "tariq", "amira", "samir", "yasmin", "khalid", "noor",
  "kofi", "ama", "kwame", "abena", "sipho", "zola", "tunde", "amara",
  "liam", "emma", "noah", "ava", "mason", "mia", "logan", "zoe",
  "dmitri", "irina", "alexei", "tatiana", "nikolai", "vera", "sergei", "daria",
];

export const LAST_NAMES: string[] = [
  "smith", "johnson", "williams", "brown", "jones", "miller", "davis", "wilson",
  "taylor", "clark", "hall", "young", "walker", "wright", "hill", "green",
  "baker", "carter", "turner", "parker", "collins", "reed", "murphy", "cook",
  "garcia", "rodriguez", "martinez", "lopez", "gonzalez", "perez", "sanchez", "torres",
  "ramirez", "flores", "rivera", "gomez", "diaz", "ortiz", "moreno", "delgado",
  "moreau", "laurent", "dubois", "bernard", "girard", "rousseau", "lambert", "fontaine",
  "rossi", "russo", "ferrari", "esposito", "bianchi", "romano", "colombo", "ricci",
  "berg", "lindqvist", "nilsson", "holm", "dahl", "lund", "hansen", "olsen",
  "kowalski", "nowak", "wojcik", "kaminski", "zielinski", "szymanski", "mazur", "krol",
  "tanaka", "sato", "suzuki", "takahashi", "watanabe", "yamamoto", "nakamura", "kobayashi",
  "sharma", "patel", "singh", "kumar", "gupta", "mehta", "verma", "rao",
  "hassan", "ali", "ahmed", "khalil", "aziz", "rahman", "farah", "nasser",
  "mensah", "okafor", "abara", "dlamini", "moyo", "keita", "toure", "diallo",
  "novak", "horvat", "kovac", "petrov", "ivanov", "volkov", "sokolov", "orlov",
  "weber", "wagner", "becker", "hoffmann", "schulz", "keller", "richter", "wolf",
  "silva", "santos", "oliveira", "pereira", "costa", "almeida", "carvalho", "ribeiro",
];

export interface GeneratedName {
  first: string;
  last: string;
}

export function generateName(random: () => number = Math.random): GeneratedName {
  const first = FIRST_NAMES[Math.floor(random() * FIRST_NAMES.length)]!;
  const last = LAST_NAMES[Math.floor(random() * LAST_NAMES.length)]!;
  return { first, last };
}

export function capitalize(s: string | null): string | null {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}
