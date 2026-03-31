document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('leadForm');
    const submitBtn = document.getElementById('submitBtn');
    const resultsSection = document.getElementById('resultsSection');
    const leadsContainer = document.getElementById('leadsContainer');
    const progressContainer = document.getElementById('progressContainer');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const resultCount = document.getElementById('resultCount');
    const downloadBtn = document.getElementById('downloadBtn');
    const downloadLocationsBtn = document.getElementById('downloadLocationsBtn');
    const errorMessage = document.getElementById('errorMessage');
    
    let currentDownloadUrl = null;
    let currentLocationsUrl = null;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const country = document.getElementById('country').value.trim();
        const industry = document.getElementById('industry').value.trim();

        if (!country || !industry) {
            showError('Please fill in both country and industry');
            return;
        }

        await generateLeads(country, industry);
    });

    downloadBtn.addEventListener('click', () => {
        if (currentDownloadUrl) {
            window.location.href = currentDownloadUrl;
        }
    });

    downloadLocationsBtn.addEventListener('click', () => {
        if (currentLocationsUrl) {
            window.location.href = currentLocationsUrl;
        }
    });

    async function generateLeads(country, industry) {
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Generating...';
        resultsSection.classList.remove('hidden');
        progressContainer.classList.remove('hidden');
        leadsContainer.innerHTML = '';
        errorMessage.classList.add('hidden');
        downloadBtn.classList.add('hidden');
        downloadLocationsBtn.classList.add('hidden');
        currentDownloadUrl = null;
        currentLocationsUrl = null;
        
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting city & ZIP discovery...';
        let leads = [];
        let targets = [];

        try {
            const response = await fetch('/api/generate-leads', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ country, industry })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to generate leads');
            }

            if (data.leads && Array.isArray(data.leads)) {
                leads = data.leads;
                targets = data.targets || [];
                displayLeads(leads);
                resultCount.textContent = `${leads.length} lead${leads.length !== 1 ? 's' : ''} found across ${targets.length || 0} locations`;

                if (data.downloadUrl) {
                    currentDownloadUrl = data.downloadUrl;
                    downloadBtn.classList.remove('hidden');
                }

                if (data.locationsDownload) {
                    currentLocationsUrl = data.locationsDownload;
                    downloadLocationsBtn.classList.remove('hidden');
                }

                progressBar.style.width = '100%';
                progressText.textContent = `✅ Complete! Analyzed ${leads.length} lead${leads.length !== 1 ? 's' : ''} across ${targets.length || 0} areas.`;
            }
        } catch (error) {
            console.error('Error:', error);
            showError(error.message);
            progressContainer.classList.add('hidden');
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Generate Leads';
        }
    }

    function displayLeads(leads) {
        leadsContainer.innerHTML = '';

        if (leads.length === 0) {
            leadsContainer.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 40px;">No leads found for this search. Try adjusting your country or industry.</p>';
            return;
        }

        leads.forEach((lead, index) => {
            const card = createLeadCard(lead, index + 1);
            leadsContainer.appendChild(card);
        });
    }

    function createLeadCard(lead, index) {
        const div = document.createElement('div');
        div.className = 'lead-card';
        const rating = lead.rating ?? 'N/A';
        const reviews = lead.reviews ?? 'N/A';
        div.innerHTML = `
            <div class="lead-header">
                <div class="lead-name">#${index} ${escapeHtml(lead.name)}</div>
                <div class="lead-reviews">⭐ ${escapeHtml(rating)} (${escapeHtml(reviews)})</div>
            </div>

            <div class="lead-body">
                <div class="lead-field">
                    <div class="field-label">📞 Phone</div>
                    <div class="field-value">${escapeHtml(lead.phone)}</div>
                </div>

                <div class="lead-field">
                    <div class="field-label">✉️ Email</div>
                    <div class="field-value">
                        ${lead.email && lead.email !== 'Not Found' 
                            ? `<a href="mailto:${escapeHtml(lead.email)}">${escapeHtml(lead.email)}</a>` 
                            : '❌ Not Found'}
                    </div>
                </div>

                <div class="lead-field">
                    <div class="field-label">🌐 Website</div>
                    <div class="field-value">
                        <a href="${escapeHtml(lead.website)}" target="_blank" rel="noopener noreferrer">Visit →</a>
                    </div>
                </div>

                <div class="lead-field">
                    <div class="field-label">🎯 Vibe</div>
                    <div class="field-value"><span class="vibe-tag">${escapeHtml(lead.vibe || 'N/A')}</span></div>
                </div>

                <div class="lead-field">
                    <div class="field-label">🧭 Source</div>
                    <div class="field-value">${escapeHtml(lead.sourceCity || 'N/A')} (${escapeHtml(lead.sourceZip || 'N/A')})</div>
                </div>
            </div>

            <div class="lead-pitch">
                <div class="pitch-label">📝 Overview</div>
                <div class="pitch-text">${escapeHtml(lead.overview || 'N/A')}</div>
            </div>

            <div class="lead-pitch" style="margin-top: 15px;">
                <div class="pitch-label">💬 Icebreaker</div>
                <div class="pitch-text">${escapeHtml(lead.icebreaker || 'N/A')}</div>
            </div>
        `;
        return div;
    }

    function showError(message) {
        errorMessage.textContent = `❌ Error: ${message}`;
        errorMessage.classList.remove('hidden');
    }

    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.toString().replace(/[&<>"']/g, m => map[m]);
    }
});
