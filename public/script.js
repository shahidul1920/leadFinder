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
    const errorMessage = document.getElementById('errorMessage');
    
    let currentDownloadUrl = null;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();

        const location = document.getElementById('location').value.trim();
        const industry = document.getElementById('industry').value.trim();

        if (!location || !industry) {
            showError('Please fill in both location and industry');
            return;
        }

        await generateLeads(location, industry);
    });

    downloadBtn.addEventListener('click', () => {
        if (currentDownloadUrl) {
            window.location.href = currentDownloadUrl;
        }
    });

    async function generateLeads(location, industry) {
        submitBtn.disabled = true;
        submitBtn.textContent = '⏳ Generating...';
        resultsSection.classList.remove('hidden');
        progressContainer.classList.remove('hidden');
        leadsContainer.innerHTML = '';
        errorMessage.classList.add('hidden');
        downloadBtn.classList.add('hidden');
        
        progressBar.style.width = '0%';
        progressText.textContent = 'Starting analysis...';
        let leads = [];

        try {
            const response = await fetch('/api/generate-leads', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ location, industry })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to generate leads');
            }

            if (data.leads && Array.isArray(data.leads)) {
                leads = data.leads;
                displayLeads(leads);
                resultCount.textContent = `${leads.length} lead${leads.length !== 1 ? 's' : ''} found`;

                if (data.downloadUrl) {
                    currentDownloadUrl = data.downloadUrl;
                    downloadBtn.classList.remove('hidden');
                }

                progressBar.style.width = '100%';
                progressText.textContent = `✅ Complete! Analyzed ${leads.length} lead${leads.length !== 1 ? 's' : ''}.`;
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
            leadsContainer.innerHTML = '<p style="text-align: center; color: var(--text-light); padding: 40px;">No leads found for this search. Try adjusting your location or industry.</p>';
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
        div.innerHTML = `
            <div class="lead-header">
                <div class="lead-name">#${index} ${escapeHtml(lead.name)}</div>
                <div class="lead-reviews">⭐ ${lead.rating} (${lead.reviews})</div>
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
                    <div class="field-value"><span class="vibe-tag">${escapeHtml(lead.vibe)}</span></div>
                </div>
            </div>

            <div class="lead-pitch">
                <div class="pitch-label">💡 Pitch Angle</div>
                <div class="pitch-text">${escapeHtml(lead.angle)}</div>
            </div>

            <div class="lead-pitch" style="margin-top: 15px;">
                <div class="pitch-label">💬 Icebreaker</div>
                <div class="pitch-text">${escapeHtml(lead.icebreaker)}</div>
            </div>
        `;
        return div;
    }

    function showError(message) {
        errorMessage.textContent = `❌ Error: ${message}`;
        errorMessage.classList.remove('hidden');
    }

    function escapeHtml(text) {
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, m => map[m]);
    }
});
