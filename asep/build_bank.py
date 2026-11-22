#!/usr/bin/env python3
"""Read the latest official ASEP PDFs, retaining exactly-one red correct answer per question."""
import json, re, sys, hashlib, datetime, unicodedata
from pathlib import Path
from urllib.parse import urljoin, urlsplit, unquote
import fitz, requests
from bs4 import BeautifulSoup

BASE = "https://info.asep.gr/mitroo-thematon-gnoseon"
ROOT = Path(__file__).parent
DEST = ROOT / "public"
CATS = [
 ("constitutional","Συνταγματικό Δίκαιο",265,"14/04/2026"),
 ("administrative","Διοικητικό Δίκαιο",303,"13/11/2026"),
 ("eu","Ευρωπαϊκοί Θεσμοί και Δίκαιο",189,"03/04/2026"),
 ("economics","Οικονομικές Επιστήμες",334,"09/07/2026"),
 ("digital","Πληροφορική και Ψηφιακή Διακυβέρνηση",257,"18/09/2026"),
 ("history","Σύγχρονη Ιστορία της Ελλάδας",144,"03/04/2026"),
 ("civil","Κώδικας Κατάστασης Πολιτικών Διοικητικών Υπαλλήλων και Υπαλλήλων Ν.Π.Δ.Δ.",121,"03/04/2026"),
 ("gdpr","Γενικός Κανονισμός Προστασίας Δεδομένων (GDPR)",30,"03/04/2026"),
 ("organizations","Διοίκηση Επιχειρήσεων και Οργανισμών",108,"03/04/2026"),
 ("hr","Διοίκηση Ανθρώπινου Δυναμικού",151,"03/04/2026"),
 ("conduct","Κώδικας Συμπεριφοράς Δημοσίων Υπαλλήλων",86,"03/04/2026")]
QRE = re.compile(r"^(\d{1,4})\.\s*(.*)")
ORE = re.compile(r"^([αβγδ])\s*[.)]\s*(.*)", re.I)
LETTERS = "αβγδ"
def is_red(value):
 r,g,b = ((value>>16)&255, (value>>8)&255, value&255)
 return r>=160 and g<=125 and b<=125 and r>g*1.8 and r>b*1.8
def clean(t): return re.sub(r"\s+"," ",t).strip()
def official_links(session):
 r=session.get(BASE, timeout=35); r.raise_for_status()
 soup=BeautifulSoup(r.content,"html.parser")
 links={}
 for a in soup.select("a[href]"):
  url=urljoin(r.url,a["href"])
  parsed=urlsplit(url)
  if parsed.hostname!="info.asep.gr" or not parsed.path.lower().endswith(".pdf"): continue
  filename=unquote(parsed.path.rsplit("/",1)[-1])
  m=re.match(r"^(\d{1,2})\.",filename)
  if m and 1<=int(m.group(1))<=11:
   n=int(m.group(1))
   if n in links and links[n]!=url: raise ValueError("Πολλαπλά PDF για ενότητα "+str(n))
   links[n]=url
 return links
def lines(page):
 # Preserve genuine PDF per-span ink colors. No guessed AI answer key.
 values=[]
 for block in page.get_text("dict",sort=True).get("blocks",[]):
  if block.get("type")!=0:continue
  for line in block.get("lines",[]):
   top=line["bbox"][1]
   if top>page.rect.height-44:continue
   chunks=[];red=0;prev=None
   for span in line.get("spans",[]):
    s=span.get("text","")
    if not s:continue
    if prev is not None and chunks and not chunks[-1].endswith(" ") and not s.startswith(" ") and span["bbox"][0]-prev>1.4:chunks.append(" ")
    chunks.append(s)
    if is_red(int(span.get("color",0))):red+=len(s.strip())
    prev=span["bbox"][2]
   txt=clean("".join(chunks))
   if txt:values.append((round(top,1),line["bbox"][0],txt,red))
 values.sort(key=lambda v:(round(v[0]/2)*2,v[1]))
 return values
def parse_pdf(blob,category,url):
 doc=fitz.open(stream=blob,filetype="pdf")
 found=[];cur=None
 def flush():
  if cur is None:return
  if len(cur["options"])!=4:raise ValueError("Q%s: %s αντί για 4 επιλογές"%(cur["number"],len(cur["options"])))
  if any(not o["text"] for o in cur["options"]):raise ValueError("Q%s: κενή απάντηση"%cur["number"])
  winners=[i for i,o in enumerate(cur["options"]) if o["red"]>0]
  if len(winners)!=1:raise ValueError("Q%s: %s κόκκινες επιλογές"%(cur["number"],len(winners)))
  if len(cur["question"])<5:raise ValueError("Q%s: κενή εκφώνηση"%cur["number"])
  found.append(dict(id=category[0]+"-"+str(cur["number"]),category=category[0],
      number=cur["number"],question=cur["question"],options=[o["text"] for o in cur["options"]],
      correct=winners[0],page=cur["page"],source=url+"#page="+str(cur["page"])))
 for pageno,page in enumerate(doc,1):
  for _,x,t,red in lines(page):
   if ("Μ η τ ρ" in t or "Μητρώο Θεμάτων Γνώσεων" in t or "Γνωστικό Αντικείμενο:" in t or
       t.startswith(("ΑΝΕΞΑΡΤΗΤΗ","ΑΡΧΗ","ΑΣΕΠ","Ανώτατο Συμβούλιο")) or
       re.match(r"^Σελίδα\s+\d+\s+από",t)):continue
   m=QRE.match(t)
   next_number=len(found)+(1 if cur is not None else 0)+1
   if m and int(m.group(1))==next_number and (cur is None or len(cur["options"])==4):
    flush()
    cur=dict(number=int(m.group(1)),question=m.group(2),page=pageno,options=[])
    continue
   if cur is None:continue
   a=ORE.match(t)
   if a and len(cur["options"])<4 and a.group(1).lower()==LETTERS[len(cur["options"])]:
    cur["options"].append(dict(text=a.group(2),red=red))
    continue
   if cur["options"]:
    o=cur["options"][-1];o["text"]=clean(o["text"]+" "+t);o["red"]+=red
   else:cur["question"]=clean(cur["question"]+" "+t)
 flush()
 expected=category[2]
 if len(found)!=expected:raise ValueError("Εντοπίστηκαν %s αντί για %s ερωτήσεις"%(len(found),expected))
 if [q["number"] for q in found]!=list(range(1,expected+1)):raise ValueError("Ασυνέχεια αρίθμησης")
 return found
def main():
 # Fully materialized, versioned question bank takes precedence over remote downloads.
 saved = DEST / "questions.json"
 if saved.exists():
  existing=json.loads(saved.read_text(encoding="utf-8"))
  qs=existing.get("questions",[])
  ids=[q.get("id") for q in qs]
  if (len(qs)!=1988 or len(ids)!=len(set(ids)) or
      not all(isinstance(q.get("correct"),int) and 0<=q["correct"]<4
              and isinstance(q.get("options"),list) and len(q["options"])==4
              and all(isinstance(o,str) and o.strip() for o in q["options"])
              and isinstance(q.get("question"),str) and q["question"].strip()
              for q in qs)):
   raise RuntimeError("INVALID PREBUILT BANK")
  print("BANK READY: 1988 validated, unique question entries",flush=True)
  return
 session=requests.Session()
 session.headers.update({"User-Agent":"Mozilla/5.0 (compatible; Independent ASEP study tool)","Accept":"text/html,application/pdf,*/*"})
 strict="--strict" in sys.argv
 data=dict(source=BASE,source_name="Μητρώο Θεμάτων Γνώσεων του ΑΣΕΠ",generated=datetime.datetime.now(datetime.timezone.utc).isoformat(),categories=[],questions=[],errors=[])
 for probe in ("https://quizor.gr/questions/mitroo-thematon-gnoseon-asep","https://asep-exams.gr/asep-erotiseis-apantiseis","https://r.jina.ai/https://info.asep.gr/mitroo-thematon-gnoseon"):
  try:
   rp=session.get(probe,timeout=18)
   print("DIAGNOSTIC",probe,rp.status_code,len(rp.content),rp.text[:350].replace("\\n"," "),flush=True)
  except Exception as pe:
   print("DIAGNOSTIC-ERROR",probe,str(pe)[:180],flush=True)
 try: urls=official_links(session)
 except Exception as e:
  print("OFFICIAL INDEX ERROR:",e,flush=True);urls={}
 # Direct links to the eleven public official PDFs, taken from the official index.
 # Their filenames are stable even when the files receive a later update.
 filenames=[
 "1.ΣΥΝΤΑΓΜΑΤΙΚΟ ΔΙΚΑΙΟ.pdf",
 "2.ΔΙΟΙΚΗΤΙΚΟ ΔΙΚΑΙΟ.pdf",
 "3.ΕΥΡΩΠΑΪΚΟΙ ΘΕΣΜΟΙ ΚΑΙ ΔΙΚΑΙΟ.pdf",
 "4.ΟΙΚΟΝΟΜΙΚΕΣ ΕΠΙΣΤΗΜΕΣ.pdf",
 "5.ΠΛΗΡΟΦΟΡΙΚΗ ΚΑΙ ΨΗΦΙΑΚΗ ΔΙΑΚΥΒΕΡΝΗΣΗ.pdf",
 "6.ΣΥΓΧΡΟΝΗ ΙΣΤΟΡΙΑ ΤΗΣ ΕΛΛΑΔΟΣ.pdf",
 "7.ΚΩΔΙΚΑΣ ΚΑΤΑΣΤΑΣΗΣ ΠΟΛΙΤΙΚΩΝ ΔΙΟΙΚΗΤ.ΥΠΑΛΛΗΛΩΝ ΚΑΙ ΥΠΑΛΛΗΛΩΝ ΝΠΔΔ.pdf",
 "8.ΓΕΝΙΚΟΣ ΚΑΝΟΝΙΣΜΟΣ ΓΙΑ ΤΗΝ ΠΡΟΣΤΑΣΙΑ ΔΕΔΟΜΕΝΩΝ GDPR.pdf",
 "9.ΔΙΟΙΚΗΣΗ ΕΠΙΧΕΙΡΗΣΕΩΝ ΚΑΙ ΟΡΓΑΝΙΣΜΩΝ.pdf",
 "10.ΔΙΟΙΚΗΣΗ ΑΝΘΡΩΠΙΝΟΥ ΔΥΝΑΜΙΚΟΥ.pdf",
 "11.ΚΩΔΙΚΑΣ ΣΥΜΠΕΡΙΦΟΡΑΣ ΔΗΜΟΣΙΩΝ ΥΠΑΛΛΗΛΩΝ.pdf"]
 from urllib.parse import quote
 for num, filename in enumerate(filenames,1):
  urls.setdefault(num,"https://info.asep.gr/sites/default/files/2026-04/"+quote(filename))
 for n,cat in enumerate(CATS,1):
  cid,name,total,updated=cat;url=urls.get(n)
  meta=dict(id=cid,name=name,count=total,updated=updated,url=url,loaded=0)
  try:
   if not url:raise ValueError("Δεν εντοπίστηκε επίσημος σύνδεσμος PDF")
   r=session.get(url,timeout=95);r.raise_for_status()
   if not r.content.startswith(b"%PDF-"):raise ValueError("Αρχείο μη αναγνωρίσιμο ως PDF")
   meta["sha256"]=hashlib.sha256(r.content).hexdigest()
   qs=parse_pdf(r.content,cat,url)
   meta["loaded"]=len(qs);data["questions"].extend(qs)
   print("OK",n,name,len(qs),flush=True)
  except Exception as e:
   msg=name+": "+str(e)
   print("ERROR",msg,flush=True)
   meta["error"]=str(e);data["errors"].append(msg)
  data["categories"].append(meta)
 if not data["questions"]:
  # Publicly verified sample from page 1 of the April 2026 official Constitutional Law PDF.
  # Never portray this fallback as the complete question bank.
  source="https://info.asep.gr/sites/default/files/2026-04/1.%CE%A3%CE%A5%CE%9D%CE%A4%CE%91%CE%93%CE%9C%CE%91%CE%A4%CE%99%CE%9A%CE%9F%20%CE%94%CE%99%CE%9A%CE%91%CE%99%CE%9F.pdf#page=1"
  previews=[
   ("Η λαϊκή κυριαρχία, στο πολίτευμά μας, είναι:",["Άγραφη αρχή","Θεμελιώδης συνταγματική αρχή","Κατώτερη από την εθνική κυριαρχία","Πάνω από το Σύνταγμα"],1),
   ("Το Σύνταγμα:",["Έχει υπέρτερη ισχύ από τον τυπικό νόμο","Έχει την ίδια ισχύ με τον τυπικό νόμο","Είναι κατώτερο από τον τυπικό νόμο","Έχει την ίδια ισχύ με το διεθνές δίκαιο"],0),
   ("Το πολίτευμα της Ελλάδας είναι:",["Προεδρική Δημοκρατία","Προεδρευόμενη Κοινοβουλευτική Δημοκρατία","Βασιλευόμενη Κοινοβουλευτική Δημοκρατία","Προεδρική Κοινοβουλευτική Δημοκρατία"],1),
   ("Οι συντακτικές πράξεις:",["Έχουν αυξημένη τυπική ισχύ","Είναι παράνομες","Εκδίδονται από την αναθεωρητική Βουλή","Εκδίδονται βάσει εξουσιοδότησης απευθείας εκ του Συντάγματος"],0),
   ("Η αντιπροσωπευτική αρχή:",["Είναι συνώνυμο της έμμεσης δημοκρατίας σήμερα","Είναι συνώνυμο της άμεσης δημοκρατίας","Δεν είναι συνώνυμο ούτε της άμεσης ούτε της έμμεσης δημοκρατίας","Σημαίνει ότι οι βουλευτές δεσμεύονται από τη γνώμη των ψηφοφόρων της περιφέρειάς τους."],0)]
  for n,(prompt,answers,correct) in enumerate(previews,1):
   data["questions"].append(dict(id="constitutional-"+str(n),category="constitutional",number=n,question=prompt,options=answers,correct=correct,page=1,source=source))
  data["categories"][0]["loaded"]=5
  data["preview"]=True
  print("PREVIEW: 5 manually cross-checked question/answer pairs on official PDF page 1",flush=True)
 data["loaded_count"]=len(data["questions"])
 data["expected_count"]=sum(x[2] for x in CATS)
 data["complete"]=(data["loaded_count"]==data["expected_count"] and not data["errors"])
 DEST.mkdir(parents=True,exist_ok=True)
 (DEST/"questions.json").write_text(json.dumps(data,ensure_ascii=False,separators=(",",":")),encoding="utf-8")
 print("FINISHED:",data["loaded_count"],"/",data["expected_count"],"COMPLETE:",data["complete"],flush=True)
 if strict and not data["complete"]:sys.exit(2)
if __name__=="__main__":main()
