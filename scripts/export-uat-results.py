"""Export conversation UAT results to XLSX using only Python's standard library."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'UAT-Test-Results.xlsx'
HEADERS = ['Test Case ID', 'Test Scenario', 'Test Steps', 'Expected Result', 'Actual Result', 'Status', 'Browser', 'Notes / Evidence', 'Purpose']
ROWS = [
['TC-AU-002', 'Forced password change on first login', 'Log in with a Manager-issued temporary password; change it; try the temporary password and then the new password.', 'Force a password change before workspace access; reject the temporary password afterward; accept the new password.', 'First login forced a password change. Workspace navigation and direct URL access were blocked until the change. The temporary password was rejected afterward; the new password worked.', 'Passed', 'Chromium', 'Verified using a dedicated UAT account.', 'Require new users to replace temporary passwords before accessing the workspace.'],
['TC-AU-003', 'Invalid credentials and lockout', 'Enter a wrong password repeatedly, then enter the correct password. Compare errors for an existing and nonexistent email.', 'Show generic errors; either apply temporary lockout or accept the correct password according to policy.', 'Unknown email and five wrong-password attempts displayed "Invalid credentials." The correct password then signed in successfully. No lockout was observed in this run.', 'Passed', 'Chromium', 'This verified result differs from the lockout described in the originally supplied Actual Result.', 'Check generic authentication errors and behavior after repeated failed logins.'],
['TC-AU-004', 'Logout clears session', 'Open a protected request, log out, use browser Back, and reopen the request URL.', 'Back navigation and reused URLs must not restore access; redirect to login.', 'Both navigation methods redirected to login. Request details were absent, and the protected request API denied access after logout.', 'Passed', 'Chromium', 'Two scenarios passed using Hospital B request REQ-2026-0673.', 'Prevent access to private request data after logout.'],
['TC-AU-005', "Role-based access to other roles' screens", 'As Hospital, Agency, and Counselor, open the Manager-only /manager/users URL.', 'Deny all non-Manager roles access and expose no setup data.', 'All three roles were redirected to their own workspace. Manager controls were absent; the setup API denied access and returned no setup data.', 'Passed', 'Chromium', 'No visible "Access denied" message appeared; access was blocked by redirection.', 'Prevent non-Manager users from opening Manager-only screens by URL.'],
['TC-AU-006', 'Manager resets a user password', 'As Manager, reset a dedicated user password; try the previous password and then the new temporary password.', 'Manager reset succeeds and the user can log in with the new temporary password.', 'Manager reset succeeded. The previous password was rejected. The temporary password allowed login and required a password change.', 'Passed', 'Chromium', 'Verified with a dedicated UAT account.', 'Verify that Managers can help users recover account access.'],
['TC-AU-007', 'Concurrent login on two devices', 'Log in with the same account in two independent browsers; reload protected data and navigate in both.', 'Both sessions remain active, as confirmed by the user.', 'Both Manager sessions remained active after the second login. Six protected-data checks passed, including concurrent reloads and further navigation.', 'Passed', 'Two independent Chromium processes', 'Verified in independent browser processes on one machine, not two physical devices. Initial login cooldown cleared before the successful run.', 'Confirm concurrent-session behavior matches the intended policy.'],
['TC-AG-002', 'Own request', 'As Agency, create and submit an own request for PBH / PEEK / Small.', 'Price KRW 900,000; own -10% rule is not used; status SUBMITTED; Agency is payer.', 'During the verified attempt, Small was unavailable and the page displayed "No calculated quote is available. Ask a Manager to configure the applicable price." No request was submitted.', 'Blocked', 'Chromium', 'Last direct verification was blocked by pricing. Later request-list data contained other TC-AG-002 records; those runs and their outcomes were not verified in this conversation. Purpose wording originally mentioned a discount, conflicting with the expected no-discount rule.', 'Verify own-request pricing and Agency payer assignment against the stated expected result.'],
['TC-AG-003', 'Selected Agency views request', "Log in as Agency 2 and open Hospital B's request with Agency 2 selected.", 'Request is visible with no edit, cancel, or approve controls.', 'Agency 2 matched the saved agency on REQ-2026-0673. The SUBMITTED request was visible. Edit, cancel, and approve controls were absent across Summary, Files & 3D, Comments, and History, including after reload.', 'Passed', 'Chromium', 'Verified the Hospital owner had cancellation rights on the same request.', 'Allow the selected agency to view assigned requests without edit, cancel, or approve controls.'],
['TC-AG-004', 'Selected Agency sees bill', 'Log in as Agency 2 and open Billing.', 'Assigned bill is shown with amount KRW 950,000.', 'No issued KRW 950,000 bill was returned across the available 2025-2026 periods. September 2026 showed Hospital B bills REQ-2026-0061 and REQ-2026-0126 at KRW 1,140,000 each, and Agency B bill REQ-2026-0089 at KRW 1,200,000.', 'Blocked', 'Chromium, Firefox, WebKit', 'Latest reporting verification: 3 skipped with BLOCKED annotations, 0 failed. This is not a pass. Existing bill visibility was verified; the expected amount was not.', 'Verify assigned billing statements and their amounts.'],
['TC-AG-005', 'Non-selected Agency', 'As Agency 1, search the request list, paste Agency 2 request URLs, and open Billing.', 'Requests are absent from the list; direct access is denied; no bill for those requests is shown.', 'REQ-2026-0673 and REQ-2026-0061 were absent from All requests search. Direct URLs displayed "You do not have permission to perform this action." The existing Agency 2 bill was absent from Agency 1 Billing.', 'Passed', 'Chromium', 'Positive baseline verified Agency 2 could access the requests and the September 2026 bill.', 'Prevent agencies from accessing requests and bills assigned to another agency.'],
['TC-AG-006', 'After connection deactivated', 'Manager deactivates Hospital B-Agency 2 connection; Agency 2 reopens an old request; restore the connection afterward.', 'Historical request remains visible with Agency 2 preserved as the saved agency.', 'An earlier Chromium run passed and restored the connection. The test was then updated to serialize browser runs and log in once per role without logout steps. Verification of the latest version was blocked by login rate limiting before any connection change.', 'Blocked', 'Latest attempt: Chromium and Firefox', 'Latest implementation is not fully verified. Earlier Chromium result passed; user also reported a Firefox pass and a WebKit race failure before the serialization fix. Current default browsers: Chromium and Firefox.', 'Verify that historical request access and saved agency survive connection deactivation.'],
]

PROVIDED_HEADERS = ['Test Scenario', 'Test Steps', 'Expected Result', 'Actual Result (user-reported)', 'Status (user-reported)', 'Remarks', 'Purpose', 'Verification Note']
PROVIDED_ROWS = [[
'Invalid login attempts',
'Enter the wrong password several times, then try the correct password',
'Clear error shown each time; correct password still works afterward (or lock behavior shown, if implemented)',
'Entered wrong password repeatedly --> generic error message displayed and account locked with "Too many requests. Try again later." message.',
'Passed', '',
'To ensure repeated failed logins show proper error messages and lock out potential hackers.',
'Transcribed from the latest user-provided row; not independently rerun for this export. Earlier TC-AU-003 verification observed generic errors followed by successful correct-password login without lockout.'
]]

def col(index):
    result = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        result = chr(65 + remainder) + result
    return result

def sheet(headers, rows, widths, status_index):
    end = f'{col(len(headers))}{len(rows) + 1}'
    parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
        f'<dimension ref="A1:{end}"/>',
        '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>',
        '<sheetFormatPr defaultRowHeight="18"/><cols>']
    for index, width in enumerate(widths, 1):
        parts.append(f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>')
    parts.append('</cols><sheetData>')
    for row_num, values in enumerate([headers] + rows, 1):
        height = 32 if row_num == 1 else (180 if row_num == 12 else 140)
        parts.append(f'<row r="{row_num}" ht="{height}" customHeight="1">')
        for index, value in enumerate(values, 1):
            style = 1 if row_num == 1 else 2
            if row_num > 1 and index - 1 == status_index:
                style = 3 if value == 'Passed' else 4 if value == 'Blocked' else 2
            parts.append(f'<c r="{col(index)}{row_num}" s="{style}" t="inlineStr"><is><t xml:space="preserve">{escape(str(value))}</t></is></c>')
        parts.append('</row>')
    parts.extend(['</sheetData>', f'<autoFilter ref="A1:{end}"/>',
        '<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>',
        '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>', '</worksheet>'])
    return ''.join(parts)

STYLES = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF17365D"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2F0D9"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFE699"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border/><border><left style="thin"><color rgb="FFD9E2F3"/></left><right style="thin"><color rgb="FFD9E2F3"/></right><top style="thin"><color rgb="FFD9E2F3"/></top><bottom style="thin"><color rgb="FFD9E2F3"/></bottom></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="4" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="top" wrapText="1"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'''

with ZipFile(OUTPUT, 'w', ZIP_DEFLATED) as book:
    book.writestr('[Content_Types].xml', '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>''')
    book.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
    book.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="UAT Results" sheetId="1" r:id="rId1"/><sheet name="Provided Invalid Login" sheetId="2" r:id="rId2"/></sheets></workbook>')
    book.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
    book.writestr('xl/styles.xml', STYLES)
    book.writestr('xl/worksheets/sheet1.xml', sheet(HEADERS, ROWS, [16, 32, 48, 50, 72, 14, 28, 70, 48], 5))
    book.writestr('xl/worksheets/sheet2.xml', sheet(PROVIDED_HEADERS, PROVIDED_ROWS, [28, 48, 60, 68, 20, 20, 55, 70], 4))

# Validate archive integrity and parse every XML part before delivering.
import xml.etree.ElementTree as ET
with ZipFile(OUTPUT) as book:
    assert book.testzip() is None
    for name in book.namelist():
        ET.fromstring(book.read(name))
    ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    assert len(ET.fromstring(book.read('xl/worksheets/sheet1.xml')).findall('s:sheetData/s:row', ns)) == 12
    assert len(ET.fromstring(book.read('xl/worksheets/sheet2.xml')).findall('s:sheetData/s:row', ns)) == 2
print(f'Created and validated: {OUTPUT}')
print('11 UAT cases plus the latest user-provided invalid-login row in a separate sheet.')
