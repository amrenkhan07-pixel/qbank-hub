// Canonical Taxonomy v1 DRAFT. Platform/source-test names are intentionally absent.
// Each topic may sit directly below a subject or below an optional medical system.
export const taxonomyVersion = {
  key: 'canonical-medical-v1',
  name: 'Canonical Taxonomy v1',
  status: 'draft',
  description: 'Review draft for NEET-PG and INI-CET concept classification; not yet assigned to questions.',
};

const t = (name, subtopics, aliases = []) => ({ name, subtopics, aliases });
const s = (name, topics) => ({ name, topics });

export const taxonomy = [
  { name: 'Anatomy', systems: [
    s('General & Developmental Anatomy', [
      t('General Anatomy', ['Terminology and planes', 'Bones and joints', 'Muscles and fascia', 'Blood vessels and lymphatics'], ['ossification','joint','fascia','lymphatic']),
      t('Embryology', ['Gametogenesis and fertilization', 'Early embryonic development', 'Placenta and fetal membranes', 'Congenital anomalies and teratology'], ['embryo','placenta','teratogen','neural tube']),
      t('Histology', ['Epithelium and glands', 'Connective tissue', 'Muscle and nerve tissue', 'Microscopy and tissue identification'], ['histology','epithelium','microscopy']),
      t('Genetics', ['Chromosomes and cell division', 'Patterns of inheritance', 'Molecular genetics', 'Chromosomal disorders'], ['karyotype','inheritance','chromosome']),
    ]),
    s('Head, Neck & Neuroanatomy', [
      t('Head and Neck', ['Scalp and face', 'Deep spaces of neck', 'Pharynx and larynx', 'Thyroid and salivary glands'], ['parotid','larynx','pharynx','thyroid']),
      t('Cranial Nerves', ['Motor cranial nerves', 'Sensory cranial nerves', 'Parasympathetic pathways', 'Cranial nerve lesions'], ['cranial nerve','trigeminal','facial nerve','vagus']),
      t('Brain and Spinal Cord', ['Cerebral cortex and white matter', 'Brainstem', 'Cerebellum', 'Spinal cord tracts'], ['cortex','brainstem','cerebell','spinal tract']),
      t('Meninges and Cerebral Circulation', ['Meninges and dural sinuses', 'Ventricles and CSF', 'Arterial supply of brain', 'Intracranial hemorrhage anatomy'], ['dural sinus','csf','circle of willis','meninges']),
    ]),
    s('Thorax, Abdomen & Pelvis', [
      t('Thorax', ['Thoracic wall and diaphragm', 'Mediastinum', 'Heart anatomy', 'Lungs and pleura'], ['mediastinum','pleura','diaphragm']),
      t('Abdomen', ['Anterior abdominal wall', 'Peritoneum and spaces', 'Gastrointestinal viscera', 'Hepatobiliary and splenic anatomy'], ['peritoneum','portal vein','lesser sac']),
      t('Pelvis and Perineum', ['Pelvic walls and floor', 'Pelvic viscera', 'Perineum', 'Pelvic neurovasculature'], ['pelvic floor','perineum','ischiorectal']),
    ]),
    s('Limbs', [
      t('Upper Limb', ['Brachial plexus', 'Shoulder and arm', 'Forearm and hand', 'Upper-limb vessels and spaces'], ['brachial plexus','carpal tunnel','rotator cuff']),
      t('Lower Limb', ['Lumbosacral plexus', 'Hip and thigh', 'Leg and foot', 'Lower-limb vessels and spaces'], ['sciatic','femoral triangle','tarsal tunnel']),
    ]),
  ]},
  { name: 'Physiology', systems: [
    s('General & Cellular Physiology', [
      t('Cell Physiology', ['Cell membrane transport', 'Membrane potential', 'Cell signaling', 'Homeostasis'], ['membrane potential','action potential','second messenger']),
      t('Nerve and Muscle', ['Skeletal muscle contraction', 'Neuromuscular junction', 'Smooth muscle', 'Peripheral nerve physiology'], ['neuromuscular','sarcomere','motor unit']),
    ]),
    s('Cardiovascular System', [
      t('Cardiac Physiology', ['Cardiac cycle', 'ECG and conduction', 'Cardiac output', 'Coronary circulation'], ['cardiac cycle','ecg','ejection fraction']),
      t('Circulation', ['Blood pressure regulation', 'Microcirculation', 'Regional circulation', 'Hemodynamic responses'], ['baroreceptor','vascular resistance','microcirculation']),
    ]),
    s('Respiratory System', [
      t('Pulmonary Mechanics', ['Lung volumes and capacities', 'Compliance and surfactant', 'Airway resistance', 'Work of breathing'], ['spirometry','compliance','surfactant']),
      t('Gas Exchange and Control', ['Ventilation perfusion', 'Oxygen transport', 'Carbon dioxide transport', 'Control of respiration'], ['v/q','oxygen dissociation','respiratory center']),
    ]),
    s('Renal & Acid-Base', [
      t('Renal Physiology', ['Glomerular filtration', 'Tubular transport', 'Concentration and dilution', 'Renal endocrine function'], ['gfr','clearance','countercurrent']),
      t('Fluid, Electrolytes and Acid-Base', ['Body fluid compartments', 'Sodium and water balance', 'Potassium balance', 'Acid-base physiology'], ['anion gap','osmolality','acid base']),
    ]),
    s('Gastrointestinal & Endocrine', [
      t('Gastrointestinal Physiology', ['Motility', 'Gastrointestinal secretions', 'Digestion and absorption', 'Hepatobiliary physiology'], ['gastrin','secretin','absorption']),
      t('Endocrine Physiology', ['Hypothalamic pituitary axis', 'Thyroid physiology', 'Adrenal physiology', 'Insulin and metabolic hormones'], ['pituitary','thyroid hormone','cortisol','insulin']),
    ]),
    s('Nervous System & Special Senses', [
      t('Central Nervous System Physiology', ['Synapses and neurotransmission', 'Sensory systems', 'Motor control', 'Higher functions and sleep'], ['synapse','sleep','basal ganglia']),
      t('Special Senses', ['Vision', 'Hearing', 'Taste and smell', 'Vestibular physiology'], ['visual pathway','audiometry','vestibular']),
    ]),
    s('Reproductive & Exercise Physiology', [
      t('Reproductive Physiology', ['Male reproductive physiology', 'Menstrual cycle', 'Pregnancy and lactation', 'Puberty and menopause'], ['menstrual cycle','lactation','spermatogenesis']),
      t('Exercise and Environmental Physiology', ['Exercise responses', 'High altitude', 'Temperature regulation', 'Diving and aviation'], ['high altitude','thermoregulation','exercise']),
    ]),
  ]},
  { name: 'Biochemistry', topics: [
    t('Biomolecules and Enzymes', ['Amino acids and proteins', 'Carbohydrates and lipids', 'Nucleotides', 'Enzyme kinetics and regulation'], ['enzyme kinetics','michaelis','amino acid']),
    t('Carbohydrate Metabolism', ['Glycolysis and gluconeogenesis', 'TCA cycle and oxidative phosphorylation', 'Glycogen metabolism', 'Pentose phosphate pathway'], ['glycolysis','tca','glycogen','hmp shunt']),
    t('Lipid Metabolism', ['Fatty acid oxidation and synthesis', 'Ketone bodies', 'Cholesterol and lipoproteins', 'Eicosanoids'], ['beta oxidation','ketone','lipoprotein']),
    t('Amino Acid and Heme Metabolism', ['Amino acid catabolism', 'Urea cycle', 'Inborn errors of metabolism', 'Heme and bilirubin metabolism'], ['urea cycle','phenylketonuria','porphyria','bilirubin']),
    t('Molecular Biology', ['DNA replication and repair', 'Transcription and RNA processing', 'Translation and genetic code', 'Gene regulation and molecular techniques'], ['pcr','dna repair','transcription','translation']),
    t('Nutrition and Vitamins', ['Energy and macronutrients', 'Fat-soluble vitamins', 'Water-soluble vitamins', 'Minerals and trace elements'], ['vitamin','nutrition','thiamine']),
    t('Clinical Biochemistry', ['Liver and renal function tests', 'Acid-base and electrolytes', 'Tumor markers', 'Laboratory quality and interpretation'], ['tumor marker','liver function','electrophoresis']),
  ]},
  { name: 'Pathology', systems: [
    s('General Pathology', [
      t('Cell Injury and Adaptation', ['Reversible and irreversible injury', 'Necrosis and apoptosis', 'Cellular adaptations', 'Intracellular accumulations'], ['necrosis','apoptosis','metaplasia']),
      t('Inflammation and Repair', ['Acute inflammation', 'Chronic and granulomatous inflammation', 'Wound healing', 'Inflammatory mediators'], ['granuloma','wound healing','inflammation']),
      t('Hemodynamic Disorders', ['Edema and congestion', 'Thrombosis', 'Embolism and infarction', 'Shock and DIC'], ['thrombus','embolism','infarct','dic']),
      t('Neoplasia', ['Tumor biology and nomenclature', 'Carcinogenesis', 'Tumor spread and staging', 'Tumor markers and paraneoplastic syndromes'], ['oncogene','tumor suppressor','metastasis']),
      t('Immune and Genetic Disease', ['Hypersensitivity', 'Autoimmunity', 'Immunodeficiency', 'Genetic and pediatric disorders'], ['hypersensitivity','autoimmune','immunodeficiency']),
    ]),
    s('Hematolymphoid System', [
      t('Red Cell Disorders', ['Microcytic anemia', 'Macrocytic anemia', 'Hemolytic anemia', 'Bone marrow failure'], ['anemia','thalassemia','spherocytosis']),
      t('White Cell and Lymphoid Disorders', ['Acute leukemia', 'Chronic leukemia', 'Lymphoma', 'Plasma cell disorders'], ['leukemia','lymphoma','myeloma']),
      t('Hemostasis Disorders', ['Platelet disorders', 'Coagulation disorders', 'Thrombophilia', 'Transfusion pathology'], ['hemophilia','von willebrand','platelet']),
    ]),
    s('Systemic Pathology', [
      t('Cardiovascular Pathology', ['Atherosclerosis and aneurysm', 'Ischemic heart disease', 'Valvular and myocardial disease', 'Vasculitis'], ['atherosclerosis','myocardial infarction','vasculitis']),
      t('Respiratory Pathology', ['Obstructive lung disease', 'Restrictive lung disease', 'Pneumonia and infections', 'Lung tumors'], ['emphysema','asthma','lung carcinoma']),
      t('Gastrointestinal and Hepatobiliary Pathology', ['Esophagus and stomach', 'Intestinal disease', 'Liver disease', 'Pancreatic and biliary disease'], ['cirrhosis','crohn','ulcerative colitis']),
      t('Renal Pathology', ['Glomerular disease', 'Tubulointerstitial disease', 'Renal vascular disease', 'Renal tumors'], ['glomerulonephritis','nephrotic','renal cell carcinoma']),
      t('Endocrine Pathology', ['Pituitary and thyroid', 'Parathyroid', 'Adrenal', 'Endocrine pancreas'], ['thyroid carcinoma','pheochromocytoma','insulinoma']),
      t('Reproductive and Breast Pathology', ['Female genital tract', 'Male genital tract', 'Breast disease', 'Gestational trophoblastic disease'], ['cervical carcinoma','breast carcinoma','seminoma']),
      t('Neuropathology and Musculoskeletal Pathology', ['CNS infection and degeneration', 'CNS tumors', 'Bone and soft-tissue tumors', 'Arthritis and muscle disease'], ['glioma','osteosarcoma','meningioma']),
    ]),
  ]},
  { name: 'Pharmacology', topics: [
    t('General Pharmacology', ['Pharmacokinetics', 'Pharmacodynamics', 'Adverse drug reactions', 'Clinical trials and pharmacovigilance'], ['half life','clearance','receptor','adverse drug']),
    t('Autonomic Pharmacology', ['Cholinergic drugs', 'Anticholinergic drugs', 'Adrenergic agonists', 'Adrenergic antagonists'], ['muscarinic','atropine','beta blocker']),
    t('Cardiovascular and Renal Drugs', ['Antihypertensives', 'Antianginal and heart failure drugs', 'Antiarrhythmics', 'Diuretics'], ['ace inhibitor','antiarrhythmic','diuretic']),
    t('Central Nervous System Drugs', ['Sedative hypnotics and anesthetics', 'Antiepileptics', 'Antipsychotics and antidepressants', 'Opioids and pain pharmacology'], ['antiepileptic','antipsychotic','opioid']),
    t('Antimicrobial Chemotherapy', ['Antibacterial drugs', 'Antitubercular and antileprosy drugs', 'Antiviral drugs', 'Antifungal and antiparasitic drugs'], ['antibiotic','antitubercular','antiviral','antifungal']),
    t('Endocrine and Reproductive Drugs', ['Diabetes drugs', 'Thyroid drugs', 'Corticosteroids', 'Sex hormones and contraception'], ['insulin','metformin','steroid','contraceptive']),
    t('Inflammation, Immunity and Cancer Drugs', ['NSAIDs and gout drugs', 'Antihistamines', 'Immunomodulators', 'Anticancer drugs'], ['nsaid','antihistamine','chemotherapy']),
    t('Gastrointestinal and Respiratory Drugs', ['Acid peptic disease drugs', 'Antiemetics and prokinetics', 'Asthma and COPD drugs', 'Miscellaneous respiratory drugs'], ['proton pump','antiemetic','bronchodilator']),
  ]},
  { name: 'Microbiology', topics: [
    t('General Microbiology and Immunology', ['Microbial structure and genetics', 'Sterilization and disinfection', 'Innate and adaptive immunity', 'Vaccines and immunodiagnosis'], ['sterilization','immunoglobulin','vaccine']),
    t('Bacteriology', ['Gram-positive bacteria', 'Gram-negative bacteria', 'Mycobacteria', 'Spirochetes and atypical bacteria'], ['staphylococcus','streptococcus','mycobacter','salmonella']),
    t('Virology', ['DNA viruses', 'RNA viruses', 'HIV and retroviruses', 'Viral diagnosis and prevention'], ['virus','hiv','hepatitis b','influenza']),
    t('Mycology', ['Superficial and cutaneous mycoses', 'Subcutaneous mycoses', 'Systemic mycoses', 'Opportunistic fungi'], ['candida','aspergillus','fungal']),
    t('Parasitology', ['Protozoal infections', 'Cestodes', 'Trematodes', 'Nematodes'], ['malaria','amoeba','taenia','filaria']),
    t('Clinical and Applied Microbiology', ['Healthcare-associated infection', 'Antimicrobial resistance', 'Specimen collection and diagnosis', 'Syndromic microbiology'], ['nosocomial','antimicrobial resistance','culture media']),
  ]},
  { name: 'Forensic Medicine', topics: [
    t('Medical Jurisprudence', ['Consent and confidentiality', 'Medical negligence', 'Professional conduct', 'Courts and medical evidence'], ['consent','negligence','medical council']),
    t('Identification and Forensic Science', ['Age and sex estimation', 'Fingerprints and biometrics', 'DNA profiling', 'Anthropometry and skeletal remains'], ['fingerprint','dna profiling','ossification center']),
    t('Thanatology', ['Death and certification', 'Postmortem changes', 'Time since death', 'Autopsy'], ['rigor mortis','postmortem','autopsy']),
    t('Mechanical Injuries', ['Blunt force injuries', 'Sharp force injuries', 'Firearm injuries', 'Regional injuries'], ['abrasion','laceration','firearm']),
    t('Asphyxial and Environmental Deaths', ['Hanging and strangulation', 'Drowning', 'Thermal injuries', 'Electrical and environmental injury'], ['hanging','drowning','burn']),
    t('Toxicology', ['General toxicology', 'Pesticides and corrosives', 'Alcohol and drugs of abuse', 'Plant, animal and metal poisons'], ['poison','organophosphate','alcohol']),
    t('Sexual and Reproductive Forensics', ['Sexual offences', 'Pregnancy and delivery', 'Abortion and infanticide', 'Child abuse'], ['sexual assault','infanticide','child abuse']),
  ]},
  { name: 'Community Medicine', topics: [
    t('Epidemiology', ['Measures of disease frequency', 'Study designs', 'Bias and confounding', 'Causal inference and screening'], ['incidence','prevalence','cohort','case control']),
    t('Biostatistics', ['Data and distributions', 'Sampling and estimation', 'Hypothesis testing', 'Correlation and regression'], ['standard deviation','p value','confidence interval']),
    t('Communicable Disease Control', ['Respiratory infections', 'Vector-borne diseases', 'Enteric diseases', 'Zoonoses and emerging infections'], ['surveillance','outbreak','vector control']),
    t('Noncommunicable Disease', ['Cardiovascular and diabetes prevention', 'Cancer prevention', 'Mental health programs', 'Injury and disability prevention'], ['ncd','screening program']),
    t('Maternal and Child Health', ['Antenatal and intranatal care', 'Child health and nutrition', 'Immunization program', 'Reproductive and adolescent health'], ['anc','immunization schedule','rmncha']),
    t('Nutrition and Environment', ['Nutritional assessment', 'Deficiency disorders', 'Water and sanitation', 'Air, housing and waste'], ['malnutrition','water purification','air pollution']),
    t('Health Systems and Programs', ['Primary health care', 'Health planning and management', 'National health programs', 'Health economics and insurance'], ['primary health centre','national health mission']),
    t('Occupational and Social Health', ['Occupational diseases', 'Ergonomics and prevention', 'Demography and family planning', 'Social and behavioral sciences'], ['pneumoconiosis','contraceptive prevalence','demography']),
  ]},
  { name: 'Medicine', systems: [
    s('Cardiovascular System', [t('Cardiology', ['Ischemic heart disease', 'Heart failure', 'Arrhythmias', 'Valvular and congenital heart disease'], ['angina','heart failure','atrial fibrillation','murmur'])]),
    s('Respiratory System', [t('Pulmonology', ['Obstructive airway disease', 'Interstitial and occupational lung disease', 'Pulmonary infections', 'Pleural and pulmonary vascular disease'], ['copd','asthma','interstitial lung','pleural effusion'])]),
    s('Gastrointestinal & Hepatobiliary', [t('Gastroenterology', ['Esophageal and peptic disease', 'Inflammatory bowel and malabsorption', 'Liver disease and portal hypertension', 'Pancreatic and biliary disease'], ['cirrhosis','portal hypertension','pancreatitis'])]),
    s('Renal & Electrolytes', [t('Nephrology', ['Acute kidney injury', 'Chronic kidney disease', 'Glomerular disease', 'Electrolyte and acid-base disorders'], ['acute kidney','chronic kidney','nephrotic','hyponatremia'])]),
    s('Endocrine & Metabolism', [t('Endocrinology', ['Diabetes mellitus', 'Thyroid disorders', 'Adrenal disorders', 'Pituitary and metabolic bone disease'], ['diabetes','thyrotoxicosis','cushing','acromegaly'])]),
    s('Nervous System', [t('Neurology', ['Stroke and vascular neurology', 'Seizure and epilepsy', 'Movement and demyelinating disorders', 'Neuromuscular and cognitive disorders'], ['stroke','seizure','parkinson','myasthenia'])]),
    s('Hematology & Oncology', [t('Clinical Hematology', ['Anemia', 'Leukemia and lymphoma', 'Bleeding and thrombosis', 'Transfusion and stem-cell disorders'], ['anemia','leukemia','hemophilia'])]),
    s('Infectious & Immune Disease', [
      t('Infectious Disease', ['Sepsis and fever syndromes', 'HIV and opportunistic infection', 'Tuberculosis', 'Tropical and zoonotic infections'], ['sepsis','hiv','tuberculosis','malaria']),
      t('Rheumatology', ['Inflammatory arthritis', 'Connective tissue disease', 'Vasculitis', 'Crystal and degenerative arthritis'], ['rheumatoid','lupus','vasculitis','gout']),
    ]),
    s('Emergency & Critical Care', [t('Medical Emergencies', ['Shock and resuscitation', 'Poisoning and overdose', 'Environmental emergencies', 'Critical care syndromes'], ['shock','overdose','heat stroke'])]),
  ]},
  { name: 'Surgery', systems: [
    s('General Surgical Principles', [
      t('Perioperative Care', ['Preoperative assessment', 'Fluids and electrolytes', 'Nutrition', 'Postoperative complications'], ['preoperative','postoperative','parenteral nutrition']),
      t('Trauma, Shock and Burns', ['Trauma assessment', 'Hemorrhagic shock', 'Head and chest trauma', 'Burns'], ['atls','trauma','burn']),
      t('Wounds and Surgical Infection', ['Wound healing', 'Surgical site infection', 'Soft-tissue infection', 'Antimicrobial prophylaxis'], ['wound','surgical site']),
    ]),
    s('Gastrointestinal & Hepatobiliary Surgery', [
      t('Upper Gastrointestinal Surgery', ['Esophagus', 'Stomach and peptic ulcer', 'Bariatric surgery', 'Upper GI tumors'], ['achalasia','gastric carcinoma']),
      t('Intestinal and Colorectal Surgery', ['Small bowel obstruction', 'Appendix', 'Inflammatory bowel disease', 'Colorectal and anal disease'], ['appendicitis','intestinal obstruction','hemorrhoid']),
      t('Hepatobiliary and Pancreatic Surgery', ['Gallbladder and bile ducts', 'Liver tumors and portal surgery', 'Pancreatitis', 'Pancreatic tumors'], ['gallstone','pancreatitis','whipple']),
    ]),
    s('Breast, Endocrine & Vascular Surgery', [
      t('Breast Surgery', ['Benign breast disease', 'Breast cancer diagnosis', 'Breast cancer treatment', 'Reconstruction and surveillance'], ['breast lump','breast cancer']),
      t('Endocrine Surgery', ['Thyroid', 'Parathyroid', 'Adrenal', 'Endocrine pancreas'], ['thyroidectomy','hyperparathyroid','pheochromocytoma']),
      t('Vascular Surgery', ['Peripheral arterial disease', 'Venous disease', 'Aneurysm', 'Lymphatic disease'], ['varicose vein','aneurysm','claudication']),
    ]),
    s('Urology & Transplantation', [
      t('Urology', ['Urinary obstruction and stones', 'Urologic malignancy', 'Male reproductive urology', 'Urinary trauma and infection'], ['renal stone','prostate cancer','testicular torsion']),
      t('Transplantation', ['Transplant immunology', 'Kidney transplant', 'Liver transplant', 'Organ donation'], ['transplant rejection','organ donation']),
    ]),
    s('Pediatric & Specialty Surgery', [t('Pediatric Surgery', ['Neonatal surgical emergencies', 'Congenital GI anomalies', 'Pediatric tumors', 'Pediatric urology'], ['hirschsprung','intussusception','wilms'])]),
  ]},
  { name: 'Obstetrics & Gynecology', systems: [
    s('Obstetrics', [
      t('Normal Pregnancy and Antenatal Care', ['Physiology and diagnosis of pregnancy', 'Antenatal screening', 'Fetal surveillance', 'Normal labor and puerperium'], ['antenatal','partograph','puerperium']),
      t('Medical Disorders in Pregnancy', ['Hypertensive disorders', 'Diabetes in pregnancy', 'Anemia and hematologic disease', 'Cardiac and infectious disease'], ['preeclampsia','gestational diabetes']),
      t('Obstetric Complications', ['Early pregnancy loss and ectopic pregnancy', 'Antepartum hemorrhage', 'Preterm labor and membrane rupture', 'Fetal growth and isoimmunization'], ['ectopic','placenta previa','preterm']),
      t('Operative and Emergency Obstetrics', ['Induction of labor', 'Instrumental delivery', 'Cesarean delivery', 'Postpartum hemorrhage and obstetric emergencies'], ['forceps','cesarean','postpartum hemorrhage']),
    ]),
    s('Gynecology', [
      t('Menstrual and Endocrine Disorders', ['Amenorrhea', 'Abnormal uterine bleeding', 'PCOS', 'Menopause'], ['amenorrhea','pcos','menopause']),
      t('Infertility and Reproductive Medicine', ['Female infertility', 'Male factor infertility', 'Ovulation induction', 'Assisted reproduction'], ['infertility','ivf','ovulation induction']),
      t('Gynecologic Oncology', ['Cervical neoplasia', 'Endometrial cancer', 'Ovarian tumors', 'Vulvar and vaginal cancer'], ['cervical cancer','ovarian tumor','endometrial cancer']),
      t('Benign Gynecology and Pelvic Floor', ['Fibroid and adenomyosis', 'Endometriosis', 'Pelvic infection', 'Prolapse and incontinence'], ['fibroid','endometriosis','prolapse']),
      t('Contraception and Sexual Health', ['Barrier and natural methods', 'Hormonal contraception', 'Intrauterine contraception', 'Sterilization and emergency contraception'], ['contraception','iud','sterilization']),
    ]),
  ]},
  { name: 'Pediatrics', systems: [
    s('Growth, Development & Nutrition', [
      t('Growth and Development', ['Growth assessment', 'Developmental milestones', 'Developmental delay', 'Adolescent health'], ['milestone','growth chart','developmental delay']),
      t('Pediatric Nutrition', ['Breastfeeding and complementary feeding', 'Protein-energy malnutrition', 'Micronutrient deficiency', 'Obesity'], ['breastfeeding','malnutrition','rickets']),
    ]),
    s('Neonatology', [t('Newborn Medicine', ['Neonatal resuscitation', 'Prematurity', 'Neonatal jaundice', 'Neonatal sepsis and respiratory distress'], ['newborn','premature','neonatal jaundice'])]),
    s('Pediatric Systems', [
      t('Pediatric Cardiorespiratory Disease', ['Congenital heart disease', 'Pediatric respiratory infection', 'Asthma and wheeze', 'Cystic fibrosis'], ['cyanotic','bronchiolitis','asthma']),
      t('Pediatric Gastrointestinal and Renal Disease', ['Diarrhea and dehydration', 'Liver disease', 'Nephrotic and nephritic syndromes', 'UTI and renal anomalies'], ['dehydration','nephrotic','pediatric uti']),
      t('Pediatric Neurology', ['Seizures', 'Cerebral palsy', 'Neuromuscular disease', 'CNS infection'], ['febrile seizure','cerebral palsy']),
      t('Pediatric Hematology and Oncology', ['Anemia and hemoglobinopathy', 'Bleeding disorders', 'Leukemia and lymphoma', 'Solid tumors'], ['thalassemia','leukemia','neuroblastoma']),
    ]),
    s('Infection, Immunity & Emergencies', [
      t('Immunization and Pediatric Infection', ['National immunization schedule', 'Vaccine adverse events', 'Common childhood infections', 'Immunodeficiency'], ['immunization','vaccine','exanthem']),
      t('Pediatric Emergencies and Toxicology', ['Shock', 'Respiratory failure', 'Poisoning', 'Child abuse'], ['pediatric shock','poisoning','child abuse']),
    ]),
  ]},
  { name: 'Orthopedics', systems: [
    s('Trauma', [
      t('Fracture Principles', ['Fracture healing', 'Open fractures', 'Compartment syndrome', 'Pediatric fractures'], ['fracture healing','compartment syndrome']),
      t('Upper Limb Trauma', ['Shoulder and humerus injuries', 'Elbow and forearm injuries', 'Wrist and hand injuries', 'Nerve injury'], ['colles','supracondylar','shoulder dislocation']),
      t('Lower Limb Trauma', ['Pelvis and hip injuries', 'Femur and knee injuries', 'Leg and ankle injuries', 'Foot injuries'], ['neck of femur','acl','ankle fracture']),
      t('Spine Trauma', ['Cervical spine injury', 'Thoracolumbar injury', 'Spinal cord injury', 'Immobilization and rehabilitation'], ['spinal injury','cervical fracture']),
    ]),
    s('Orthopedic Disorders', [
      t('Bone and Joint Infection', ['Osteomyelitis', 'Septic arthritis', 'Tuberculosis of bone and joint', 'Implant infection'], ['osteomyelitis','septic arthritis','pott']),
      t('Bone Tumors', ['Benign bone tumors', 'Malignant bone tumors', 'Tumor-like lesions', 'Metastatic bone disease'], ['osteosarcoma','giant cell tumor']),
      t('Pediatric and Developmental Orthopedics', ['Developmental dysplasia of hip', 'Clubfoot', 'Limb deformity', 'Skeletal dysplasia'], ['clubfoot','ddh','rickets']),
      t('Arthritis and Degenerative Disease', ['Osteoarthritis', 'Inflammatory arthritis', 'Avascular necrosis', 'Spine degeneration'], ['osteoarthritis','avascular necrosis']),
    ]),
  ]},
  { name: 'Ophthalmology', systems: [
    s('Anterior Segment', [
      t('Cornea and Conjunctiva', ['Conjunctivitis', 'Keratitis and corneal ulcer', 'Corneal dystrophy and degeneration', 'Corneal transplantation'], ['keratitis','corneal ulcer','conjunctivitis']),
      t('Lens and Cataract', ['Cataract types', 'Cataract assessment', 'Cataract surgery', 'Lens complications'], ['cataract','phacoemulsification']),
      t('Glaucoma', ['Primary open-angle glaucoma', 'Angle-closure glaucoma', 'Secondary glaucoma', 'Glaucoma diagnosis and treatment'], ['glaucoma','intraocular pressure']),
      t('Uveitis and Sclera', ['Anterior uveitis', 'Posterior uveitis', 'Scleritis and episcleritis', 'Systemic associations'], ['uveitis','scleritis']),
    ]),
    s('Posterior Segment & Neuro-ophthalmology', [
      t('Retina and Vitreous', ['Diabetic retinopathy', 'Retinal vascular disease', 'Retinal detachment', 'Macular disease'], ['retinopathy','retinal detachment','macular']),
      t('Optic Nerve and Visual Pathway', ['Optic neuritis and neuropathy', 'Papilledema', 'Visual field defects', 'Pupillary abnormalities'], ['papilledema','optic neuritis','visual field']),
    ]),
    s('Pediatric, Motility & Trauma', [
      t('Strabismus and Amblyopia', ['Ocular alignment', 'Paralytic squint', 'Amblyopia', 'Strabismus treatment'], ['squint','amblyopia']),
      t('Ocular Trauma and Emergencies', ['Mechanical trauma', 'Chemical injury', 'Intraocular foreign body', 'Acute visual loss'], ['hyphema','chemical injury','foreign body']),
      t('Community Ophthalmology', ['Refractive error', 'Blindness prevention', 'Screening', 'Low vision rehabilitation'], ['refractive error','blindness']),
    ]),
  ]},
  { name: 'ENT', systems: [
    s('Ear & Audiovestibular', [
      t('External and Middle Ear', ['Otitis externa', 'Otitis media', 'Tympanic membrane and ossicles', 'Complications of ear infection'], ['otitis','tympanic membrane','mastoiditis']),
      t('Inner Ear and Hearing', ['Sensorineural hearing loss', 'Conductive hearing loss', 'Audiology', 'Hearing rehabilitation'], ['audiometry','hearing loss','cochlear implant']),
      t('Vestibular Disorders', ['Peripheral vertigo', 'Central vertigo', 'Vestibular testing', 'Ménière disease'], ['vertigo','meniere','nystagmus']),
    ]),
    s('Nose, Sinus & Nasopharynx', [
      t('Nose and Paranasal Sinuses', ['Rhinitis', 'Sinusitis', 'Epistaxis', 'Nasal polyps and tumors'], ['epistaxis','sinusitis','nasal polyp']),
      t('Nasopharynx', ['Adenoids', 'Nasopharyngeal carcinoma', 'Eustachian tube', 'Skull-base relations'], ['adenoid','nasopharyngeal']),
    ]),
    s('Throat, Larynx & Head-Neck', [
      t('Oral Cavity and Pharynx', ['Tonsil and infection', 'Dysphagia', 'Oral and oropharyngeal cancer', 'Deep neck infection'], ['tonsil','dysphagia','quinsy']),
      t('Larynx and Airway', ['Voice disorders', 'Laryngeal cancer', 'Airway obstruction', 'Tracheostomy'], ['hoarseness','laryngeal','tracheostomy']),
      t('Head and Neck Oncology', ['Neck nodes', 'Salivary gland disease', 'Thyroid-related ENT', 'Cancer staging and rehabilitation'], ['neck node','salivary gland']),
    ]),
  ]},
  { name: 'Dermatology', topics: [
    t('Approach to Skin Disease', ['Skin morphology', 'Diagnostic tests', 'Topical therapy', 'Dermatopathology patterns'], ['papule','vesicle','biopsy']),
    t('Infections and Infestations', ['Bacterial infections', 'Viral infections', 'Fungal infections', 'Parasitic infestations'], ['impetigo','herpes','tinea','scabies']),
    t('Inflammatory Dermatoses', ['Eczema and dermatitis', 'Psoriasis', 'Lichen planus', 'Urticaria'], ['eczema','psoriasis','urticaria']),
    t('Autoimmune and Bullous Disease', ['Pemphigus', 'Pemphigoid', 'Connective tissue dermatoses', 'Vasculitis'], ['pemphigus','bullous','lupus']),
    t('Pigment, Hair and Nail Disorders', ['Hypopigmentation', 'Hyperpigmentation', 'Alopecia', 'Nail disorders'], ['vitiligo','melasma','alopecia']),
    t('Skin Tumors and Genodermatoses', ['Benign tumors', 'Keratinocyte cancer', 'Melanoma', 'Inherited skin disorders'], ['melanoma','basal cell','genodermatosis']),
    t('Sexually Transmitted Infections and Leprosy', ['Syphilis', 'Genital ulcer and discharge', 'HIV dermatology', 'Leprosy'], ['syphilis','genital ulcer','leprosy']),
  ]},
  { name: 'Psychiatry', topics: [
    t('Psychiatric Assessment', ['Mental status examination', 'Classification and diagnosis', 'Psychological testing', 'Ethics and capacity'], ['mental status','insight','capacity']),
    t('Psychotic Disorders', ['Schizophrenia', 'Other psychoses', 'Catatonia', 'Antipsychotic treatment'], ['schizophrenia','delusion','catatonia']),
    t('Mood Disorders', ['Major depression', 'Bipolar disorder', 'Suicide risk', 'Mood disorder treatment'], ['depression','mania','suicide']),
    t('Anxiety, Stress and Somatic Disorders', ['Anxiety disorders', 'Obsessive-compulsive disorder', 'Trauma-related disorders', 'Somatic symptom disorders'], ['panic','ocd','ptsd']),
    t('Substance Use and Addiction', ['Alcohol use disorder', 'Opioid and sedative use', 'Stimulant and cannabis use', 'Withdrawal and relapse prevention'], ['withdrawal','dependence','alcohol']),
    t('Child, Geriatric and Neurocognitive Psychiatry', ['Child developmental disorders', 'Behavioral disorders', 'Delirium', 'Dementia'], ['autism','adhd','delirium','dementia']),
    t('Personality, Eating and Sexual Disorders', ['Personality disorders', 'Eating disorders', 'Sleep disorders', 'Sexual disorders'], ['personality disorder','anorexia','sleep']),
  ]},
  { name: 'Radiology', topics: [
    t('Imaging Principles and Safety', ['X-ray and fluoroscopy', 'Ultrasound', 'CT and MRI', 'Radiation safety and contrast'], ['hounsfield','mri','contrast','radiation']),
    t('Chest and Cardiovascular Imaging', ['Chest radiograph', 'Thoracic CT', 'Cardiac imaging', 'Vascular imaging'], ['chest x-ray','ct thorax','angiography']),
    t('Abdominal and Pelvic Imaging', ['Hepatobiliary imaging', 'Gastrointestinal imaging', 'Genitourinary imaging', 'Pelvic imaging'], ['mrcp','barium','urography']),
    t('Neuroradiology', ['Brain CT and MRI', 'Stroke imaging', 'Spine imaging', 'Head and neck imaging'], ['diffusion restriction','ct brain','spine mri']),
    t('Musculoskeletal Imaging', ['Trauma imaging', 'Bone tumors', 'Arthritis', 'Soft-tissue imaging'], ['radiograph fracture','bone tumor']),
    t('Pediatric and Obstetric Imaging', ['Antenatal ultrasound', 'Fetal anomaly imaging', 'Neonatal imaging', 'Pediatric emergencies'], ['ultrasound pregnancy','fetal anomaly']),
    t('Interventional Radiology and Nuclear Medicine', ['Image-guided procedures', 'Vascular intervention', 'Radionuclide imaging', 'PET and therapy'], ['embolization','pet ct','scintigraphy']),
  ]},
  { name: 'Anaesthesia', systems: [
    s('Perioperative Medicine', [
      t('Preanaesthetic Evaluation', ['Risk assessment and consent', 'Airway assessment', 'Preoperative optimization', 'Fasting and premedication'], ['asa grade','mallampati','preoperative']),
      t('Monitoring and Safety', ['Basic monitoring', 'Advanced hemodynamic monitoring', 'Neuromuscular and depth monitoring', 'Equipment checks and safety'], ['capnography','pulse oximetry','bis']),
    ]),
    s('Anaesthetic Techniques', [
      t('General Anaesthesia', ['Induction and maintenance', 'Inhalational agents', 'Intravenous agents', 'Emergence and recovery'], ['propofol','sevoflurane','minimum alveolar']),
      t('Airway Management', ['Basic airway maneuvers', 'Supraglottic airway', 'Tracheal intubation', 'Difficult and emergency airway'], ['laryngoscope','endotracheal','difficult airway']),
      t('Regional Anaesthesia', ['Neuraxial anesthesia', 'Upper-limb blocks', 'Lower-limb and truncal blocks', 'Local anesthetic complications'], ['spinal anesthesia','epidural','nerve block']),
    ]),
    s('Perioperative Physiology & Crisis', [
      t('Fluids, Blood and Hemodynamics', ['Fluid therapy', 'Transfusion', 'Hypotension and vasoactive drugs', 'Coagulation management'], ['crystalloid','transfusion','vasopressor']),
      t('Respiratory and Anaesthetic Emergencies', ['Ventilation', 'Hypoxemia', 'Malignant hyperthermia', 'Anaphylaxis and perioperative arrest'], ['ventilator','malignant hyperthermia','anaphylaxis']),
    ]),
    s('Specialty Anaesthesia & Pain', [
      t('Obstetric and Pediatric Anaesthesia', ['Obstetric anesthesia', 'Pediatric airway and physiology', 'Neonatal anesthesia', 'Pediatric fluids and drugs'], ['obstetric anesthesia','pediatric anesthesia']),
      t('Critical Care and Pain', ['Postoperative analgesia', 'Acute and chronic pain', 'ICU sedation', 'Organ support and brain death'], ['analgesia','icu sedation','brain death']),
    ]),
  ]},
];

export function flattenTaxonomy() {
  const rows = [];
  const slug = (value) => value.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  taxonomy.forEach((subject, subjectIndex) => {
    const subjectCode = `subject.${slug(subject.name)}`;
    rows.push({ code: subjectCode, parentCode: null, type: 'subject', name: subject.name, sort: subjectIndex + 1, aliases: [] });
    const systems = subject.systems || [{ name: null, topics: subject.topics || [] }];
    systems.forEach((system, systemIndex) => {
      let parentCode = subjectCode;
      if (system.name) {
        const systemCode = `${subjectCode}.system.${slug(system.name)}`;
        rows.push({ code: systemCode, parentCode: subjectCode, type: 'system', name: system.name, sort: systemIndex + 1, aliases: [] });
        parentCode = systemCode;
      }
      system.topics.forEach((topic, topicIndex) => {
        const topicCode = `${subjectCode}.topic.${slug(topic.name)}`;
        rows.push({ code: topicCode, parentCode, type: 'topic', name: topic.name, sort: topicIndex + 1, aliases: topic.aliases || [] });
        topic.subtopics.forEach((subtopic, subtopicIndex) => {
          rows.push({ code: `${topicCode}.subtopic.${slug(subtopic)}`, parentCode: topicCode, type: 'subtopic', name: subtopic, sort: subtopicIndex + 1, aliases: [] });
        });
      });
    });
  });
  return rows;
}
