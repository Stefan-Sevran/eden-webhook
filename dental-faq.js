// General dental education. Clinic offerings and policies come from clinic facts.
const topics = [
  // https://www.nhs.uk/live-well/healthy-teeth-and-gums/dental-check-ups/
  ["Dental checkup or consultation", "A dentist examines the teeth, gums and mouth, discusses any concerns and explains any findings and next steps. The interval between checkups depends on the person's oral health."],
  // https://www.ada.org/resources/ada-library/oral-health-topics/x-rays-radiographs
  ["Dental X-rays or radiographs", "Images can help a dentist detect problems such as hidden cavities or bone loss. They use ionizing radiation, so the dentist decides whether an image is needed and what type based on the examination and history."],
  // https://www.nhs.uk/live-well/healthy-teeth-and-gums/dental-treatments/
  ["Routine cleaning, scale and polish, or oral prophylaxis", "A dental professional removes plaque and hardened buildup called tartar. Cleaning can include polishing. This is different from the below-gum treatment used for gum disease."],
  // https://www.aapd.org/research/oral-health-policies--recommendations/fluoride-therapy/
  ["Fluoride varnish", "A dental professional can apply fluoride varnish to help strengthen the tooth surface and prevent cavities. The dentist decides whether it is appropriate and how often it is needed."],
  // https://www.mouthhealthy.org/all-topics-a-z/sealants
  ["Dental sealants", "A thin protective coating fills the grooves on the chewing surfaces of back teeth to help prevent decay. The dentist checks which teeth could benefit."],
  // https://www.nhs.uk/live-well/healthy-teeth-and-gums/dental-treatments/
  ["Fillings", "A filling repairs an area of a tooth damaged by decay after the dentist removes the decayed material. Tooth-colored composite is one option. Material choice depends on the tooth and the repair."],
  ["Dental crowns or caps", "A crown covers a prepared tooth to restore its shape and protect it after damage or decay. Some crowns need a temporary cover while the final crown is made."],
  // https://www.nhs.uk/tests-and-treatments/root-canal-treatment/
  ["Root canal treatment or endodontics", "The dentist removes infected tissue from inside a tooth, cleans and seals the space, and restores the tooth. It can take more than one visit and the tooth may need a crown."],
  // https://www.mouthhealthy.org/all-topics-a-z/scaling-and-root-planing
  ["Gum disease treatment, deep cleaning, or scaling and root planing", "Deep cleaning removes buildup below the gumline and smooths the root surfaces. Temporary tenderness or sensitivity can follow. A dentist assesses the gums and decides whether further care is needed."],
  // https://www.geh.nhs.uk/patients-and-visitors/patients/patient-leaflets/post-operative-instructions-after-extraction
  ["Tooth extraction", "An extraction removes a tooth. Soreness and swelling can occur during healing. Infection and dry socket are possible complications. The dental team gives instructions for the specific procedure."],
  // https://www.nhs.uk/tests-and-treatments/wisdom-tooth-removal/
  ["Wisdom tooth assessment and removal", "A dentist may recommend removal if a wisdom tooth is causing problems. A tooth that causes no problems may be monitored. Possible complications include infection, dry socket and altered feeling if a nearby nerve is affected."],
  // https://www.fda.gov/medical-devices/dental-devices/dental-implants-what-you-should-know
  ["Dental implants", "An implant is placed in the jawbone to support a replacement tooth, bridge or denture. Treatment involves surgery and healing. Possible risks include infection, injury to nearby structures and the implant failing to bond with the bone."],
  // https://www.nhs.uk/live-well/healthy-teeth-and-gums/dental-treatments/
  ["Dental bridges", "A bridge is a fixed replacement for one or more missing teeth. It uses nearby teeth or implants for support. The dentist assesses what can support the bridge."],
  // https://www.nhs.uk/tests-and-treatments/dentures/
  ["Full and partial dentures", "Dentures are removable replacements for some or all teeth. They can help with chewing and speaking. They can take time to get used to and may need adjustment if they rub or loosen."],
  // https://www.nhs.uk/tests-and-treatments/braces-and-orthodontics/
  ["Braces and orthodontic treatment", "Braces gradually move teeth and can help correct bite problems. Fixed braces can trap plaque, so careful cleaning matters. Treatment length varies and retainers are usually needed afterward."],
  // https://bos.org.uk/clear-aligners/
  ["Clear aligners", "A series of removable clear trays gradually moves teeth. The trays need to be worn as directed. An orthodontic assessment is needed to determine whether aligners can handle the movements required."],
  // https://bos.org.uk/patients/retainers/
  ["Retainers", "Fixed or removable retainers help hold teeth in position after braces or aligners. Wear and care instructions depend on the type and come from the orthodontic team."],
  // https://www.ada.org/resources/ada-library/oral-health-topics/whitening/
  ["Teeth whitening or bleaching", "Whitening can lighten natural teeth. It does not lighten crowns, veneers or tooth-colored fillings. Temporary tooth sensitivity and gum irritation are common side effects."],
  // https://www.mouthhealthy.org/all-topics-a-z/veneers
  ["Dental veneers", "Veneers cover the front surface of teeth to change their appearance. Some require removing enamel, which is irreversible. Veneers can chip or come loose."],
  // https://my.clevelandclinic.org/health/treatments/10922-dental-bonding
  ["Dental bonding", "A dentist shapes tooth-colored resin to repair a small chip or change a tooth's shape or appearance. The material can stain or chip over time."],
  // https://www.mouthhealthy.org/all-topics-a-z/teeth-grinding
  // https://www.ada.org/resources/ada-library/oral-health-topics/athletic-mouth-protectors-mouthguards
  ["Night guards and sports mouthguards", "A night guard can help protect teeth from grinding. A sports mouthguard helps reduce the risk of mouth injuries during sport. They serve different purposes, and the dental team can advise on fit and type."],
  // https://www.mouthhealthy.org/all-topics-a-z/anesthesia-and-sedation
  ["Local anesthesia and sedation", "Local anesthesia numbs an area of the mouth. Sedation can help a patient relax during treatment. The dentist assesses suitability and gives any preparation or recovery instructions."]
];

// https://www.nhs.uk/symptoms/toothache/
// https://www.nhs.uk/nhs-services/dentists/how-to-find-an-emergency-or-urgent-nhs-dentist-appointment/
const dentalFaqPolicy = `Use the approved clinic facts as the only source for clinic-specific claims, including services offered, prices, hours, methods, availability, and booking rules. The general dental FAQ is for patient education only. Use only what it supports when explaining a procedure, its purpose, or general risks. A topic in the FAQ does not mean this clinic offers it. If the person asks about an unlisted clinic service, say the clinic team can confirm. Use handoff if you say you will ask the team to follow up.
Use handoff for personal suitability, symptoms, post-treatment concerns, medication or aftercare questions, or clinical details outside the FAQ. Do not diagnose, interpret photos or X-rays, recommend a treatment, give medication instructions, or predict results. For potentially urgent dental problems such as worsening swelling, severe pain, or a knocked-out permanent tooth, advise prompt urgent dental care. For difficulty breathing or swallowing, or heavy bleeding that will not stop, direct the person to local emergency services immediately, without waiting for the clinic to reply.`;

const dentalFaq = topics.map(([topic, answer]) => `- ${topic}: ${answer}`).join("\n");

module.exports = { dentalFaq, dentalFaqPolicy };
